"""Real PostgreSQL checks for shared-database login isolation.

Run only against a disposable container named rocento-ai-merge-test*.
"""

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTAINER = os.getenv("SHARED_AI_TEST_CONTAINER", "")
SHARED_DOMAIN_TABLES = (
    "domain_releases",
    "domain_sources",
    "domain_profiles",
    "domain_release_revocations",
)


@unittest.skipUnless(
    CONTAINER.startswith("rocento-ai-merge-test"), "disposable PostgreSQL required"
)
class SharedDatabaseTests(unittest.TestCase):
    @classmethod
    def sql(cls, sql, *, success=True):
        result = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                CONTAINER,
                "psql",
                "-X",
                "-U",
                "ai_owner",
                "-d",
                "assistant",
                "-At",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=sql,
            text=True,
            capture_output=True,
            check=False,
        )
        if success:
            if result.returncode:
                raise AssertionError(result.stderr)
        elif not result.returncode:
            raise AssertionError("Forbidden operation succeeded")
        return result.stdout

    @classmethod
    def setUpClass(cls):
        cls.sql(
            "CREATE ROLE ai_runtime NOLOGIN; CREATE ROLE ai_knowledge_writer NOLOGIN;"
        )
        for p in sorted((ROOT / "commerce-assistant-platform/migrations").glob("*.sql")):
            cls.sql(
                p.read_text().replace(
                    ":'tenant_id'", "'00000000-0000-0000-0000-000000000001'"
                )
            )
        cls.sql((ROOT / "commerce-ops/deploy/assistant/shared-tenants.sql").read_text())
        cls.sql("""
        CREATE ROLE ai_runtime_grocery LOGIN INHERIT IN ROLE ai_runtime;
        CREATE ROLE ai_runtime_jewelry LOGIN INHERIT IN ROLE ai_runtime;
        INSERT INTO assistant.tenant_logins VALUES
        ('ai_runtime_grocery','00000000-0000-0000-0000-000000000001','grocery'),
        ('ai_runtime_jewelry','00000000-0000-0000-0000-000000000002','jewelry');
        INSERT INTO assistant.conversations(tenant_id,customer_id,id) VALUES
        ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000011'),
        ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000011');
        CREATE ROLE ai_language_runtime NOLOGIN;
        CREATE ROLE language_grocery LOGIN INHERIT IN ROLE ai_language_runtime;
        CREATE ROLE language_jewelry LOGIN INHERIT IN ROLE ai_language_runtime;
        CREATE SCHEMA context;
        CREATE TABLE context.sessions(tenant_id uuid,session_id uuid,PRIMARY KEY(tenant_id,session_id));
        INSERT INTO context.sessions SELECT tenant_id,id FROM assistant.conversations;
        """)
        cls.sql((ROOT / "commerce-ops/deploy/assistant/shared-language-tenants.sql").read_text())
        cls.sql(
            "INSERT INTO context.tenant_logins VALUES ('language_grocery','00000000-0000-0000-0000-000000000001','grocery'),('language_jewelry','00000000-0000-0000-0000-000000000002','jewelry');"
        )

    def context(self, tenant=1):
        return f"SET SESSION AUTHORIZATION ai_runtime_grocery; SET assistant.tenant='00000000-0000-0000-0000-{tenant:012d}'; SET assistant.customer='00000000-0000-0000-0000-000000000010';"

    def test_own_customer_visible(self):
        self.assertEqual(
            self.sql(
                self.context() + "SELECT count(*) FROM assistant.conversations;"
            ).splitlines()[-1],
            "1",
        )

    def test_spoofed_tenant_cannot_read_or_write(self):
        self.assertEqual(
            self.sql(
                self.context(2) + "SELECT count(*) FROM assistant.conversations;"
            ).splitlines()[-1],
            "0",
        )
        self.sql(
            self.context(2)
            + "INSERT INTO assistant.conversations VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000099',now());",
            success=False,
        )

    def test_role_switch_does_not_change_login_tenant(self):
        self.assertEqual(
            self.sql(
                self.context(2)
                + "SET ROLE ai_runtime; SELECT count(*) FROM assistant.conversations;"
            ).splitlines()[-1],
            "0",
        )
        self.sql(self.context() + "SET ROLE ai_runtime_jewelry;", success=False)

    def test_customer_spoof_without_matching_row_denied(self):
        self.assertEqual(
            self.sql(
                self.context()
                + "SET assistant.customer='00000000-0000-0000-0000-000000000099'; SELECT count(*) FROM assistant.conversations;"
            ).splitlines()[-1],
            "0",
        )

    def test_registry_and_security_function_cannot_be_changed(self):
        self.sql(
            self.context()
            + "UPDATE assistant.tenant_logins SET tenant_id='00000000-0000-0000-0000-000000000002';",
            success=False,
        )
        self.sql(
            self.context()
            + "ALTER TABLE assistant.conversations DISABLE ROW LEVEL SECURITY;",
            success=False,
        )

    def test_maintenance_cannot_target_another_tenant(self):
        self.sql(
            self.context(2)
            + "SELECT assistant.purge_expired('00000000-0000-0000-0000-000000000002');",
            success=False,
        )
        self.sql(
            self.context()
            + "SELECT assistant.purge_expired('00000000-0000-0000-0000-000000000001');"
        )

    def test_all_tenant_assistant_data_tables_force_rls(self):
        # These immutable requirement releases are intentionally global. Tenant
        # bindings and product attestations must still pass the RLS guard.
        shared = ",".join(f"'{table}'" for table in SHARED_DOMAIN_TABLES)
        self.assertEqual(
            self.sql(
                "SELECT count(*) FROM pg_tables t JOIN pg_class c ON c.oid=(quote_ident(t.schemaname)||'.'||quote_ident(t.tablename))::regclass WHERE schemaname='assistant' AND tablename NOT IN ('deployment','tenant_logins',"
                + shared
                + ") AND NOT (c.relrowsecurity AND c.relforcerowsecurity);"
            ).strip(),
            "0",
        )

    def test_global_domain_references_are_immutable_and_read_only(self):
        for table in SHARED_DOMAIN_TABLES:
            with self.subTest(table=table):
                qualified = f"assistant.{table}"
                self.assertEqual(
                    self.sql(
                        f"SELECT count(*) FROM pg_attribute WHERE attrelid='{qualified}'::regclass AND attname='tenant_id' AND NOT attisdropped;"
                    ).strip(),
                    "0",
                )
                self.assertEqual(
                    self.sql(
                        f"SELECT count(*) FROM pg_trigger WHERE tgrelid='{qualified}'::regclass AND tgname='immutable_domain_evidence' AND tgenabled='O' AND tgfoid='assistant.immutable_domain_evidence()'::regprocedure;"
                    ).strip(),
                    "1",
                )
                for role in ("ai_runtime", "ai_knowledge_writer"):
                    self.assertEqual(
                        self.sql(
                            f"SELECT has_table_privilege('{role}','{qualified}','SELECT') AND NOT has_table_privilege('{role}','{qualified}','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');"
                        ).strip(),
                        "t",
                    )

    def test_language_sessions_are_isolated(self):
        prefix = "SET SESSION AUTHORIZATION language_grocery;"
        self.assertEqual(
            self.sql(prefix + "SELECT count(*) FROM context.sessions;").splitlines()[
                -1
            ],
            "1",
        )
        self.sql(
            prefix
            + "INSERT INTO context.sessions VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000099');",
            success=False,
        )
        self.sql(
            prefix
            + "UPDATE context.tenant_logins SET tenant_id='00000000-0000-0000-0000-000000000002';",
            success=False,
        )


if __name__ == "__main__":
    unittest.main()
