import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type AdminIdentity, type AdminUser, type UserInput } from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import { PageHeader } from "./page-header";
import { RowActions } from "./row-actions";
import { useGrid } from "./grids";

function allowed(who: AdminIdentity, permission: string) {
  return who.permissions.includes("*") || who.permissions.includes(permission);
}

const initialUser: UserInput = {
  email: "",
  name: "",
  role_id: "",
  password: "",
  active: true,
};
export function Users({ who }: { who: AdminIdentity }) {
  const q = useGrid("users", ["users"]);
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: adminApi.roles,
    enabled: allowed(who, "iam.roles.read"),
  });
  const cache = useQueryClient();
  const a = useAction();
  const [form, setForm] = useState<UserInput>({ ...initialUser });
  const [id, setId] = useState<string>();
  const [show, setShow] = useState(false);
  const [remove, setRemove] = useState<AdminUser | null>(null);
  const canWrite = allowed(who, "iam.users.write");
  const edit = (u: AdminUser) => {
    setId(u.id);
    setForm({
      email: u.email,
      name: u.name,
      role_id: u.role_id,
      active: u.active,
    });
    setShow(true);
  };
  return (
    <main>
      <PageHeader title={<>Admin users</>} description={<>Administrator accounts and assigned roles.</>} actions={<>{canWrite && allowed(who, "iam.roles.read") && (
          <button
            onClick={() => {
              setId(undefined);
              setForm({
                ...initialUser,
                role_id:
                  roles.data?.find((r) => !r.permissions.includes("*"))?.id ||
                  "",
              });
              setShow(true);
            }}
          >
            Add user
          </button>
        )}</>} />
      {q.controls}
      <Notice error>
        {a.error || q.error?.message || roles.error?.message}
      </Notice>
      {q.isPending ? (
        <p role="status">Loading users…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <EntityIdHeading/><th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                {canWrite && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {q.data?.map((u) => (
                <tr key={u.id}>
                  <EntityIdCell row={u}/><td>
                    {u.name}
                    {u.id === who.user.id && <small> (you)</small>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    {roles.data?.find((r) => r.id === u.role_id)?.name ||
                      "Assigned role"}
                  </td>
                  <td>
                    <span className={"badge " + (u.active ? "success" : "")}>
                      {u.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  {canWrite && (
                    <td>
                      <RowActions label={u.name} items={[
                        { label: "Edit", onSelect: () => edit(u) },
                        { label: "Deactivate", destructive: true, onSelect: () => setRemove(u) },
                      ]} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove && (
        <section className="panel">
          <h2>Deactivate {remove.name}?</h2>
          <p>They will be signed out. Their audit history is preserved.</p>
          <button
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                await adminApi.deleteUser(remove.id);
                setRemove(null);
                await cache.invalidateQueries();
              })
            }
          >
            Deactivate user
          </button>{" "}
          <button className="secondary" onClick={() => setRemove(null)}>
            Cancel
          </button>
        </section>
      )}
      {show && (
        <section className="panel edit-panel">
          <h2>{id ? "Edit user" : "New user"}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const body = { ...form };
                if (!body.password) delete body.password;
                await adminApi.saveUser(body, id);
                setShow(false);
                await cache.invalidateQueries();
              });
            }}
          >
            <div className="form-grid">
              <Field
                label="Full name"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Field
                label="Email"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <label className="field">
              <span>Role</span>
              <select
                required
                value={form.role_id}
                onChange={(e) => setForm({ ...form, role_id: e.target.value })}
              >
                <option value="">Choose a role</option>
                {roles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={
                id
                  ? "New password (leave blank to keep current)"
                  : "Initial password"
              }
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required={!id}
              value={form.password || ""}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />{" "}
              Active account
            </label>
            <p className="help">
              Updating an account ends its existing sessions.
            </p>
            <Notice error>{a.error}</Notice>
            <button disabled={a.busy}>
              {a.busy ? "Saving…" : "Save user"}
            </button>{" "}
            <button
              className="secondary"
              type="button"
              onClick={() => setShow(false)}
            >
              Cancel
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
