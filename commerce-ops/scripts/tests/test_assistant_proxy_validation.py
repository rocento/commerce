"""Exercise the deployment syntax gate without replacing real containers."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]


class AssistantProxyValidationTests(unittest.TestCase):
    def test_all_proxies_validate_and_failure_stops_before_service_replacement(self):
        source = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'validate_assistant_proxies() {' + source.split('validate_assistant_proxies() {', 1)[1].split('\nstart_store()', 1)[0]
        harness = '''set -e
fail() { echo "$*" >&2; exit 1; }
compose() {
  printf '%s\\n' "$*"
  [[ "$*" != *"$FAILED_PROXY -t"* || -z "$FAILED_PROXY" ]]
}
'''
        for proxy in ('', 'assistant-ingress', 'assistant-tools', 'assistant-provider'):
            with self.subTest(failed_proxy=proxy):
                result = subprocess.run(['bash', '-c', harness + function + f'\nFAILED_PROXY={proxy}\nvalidate_assistant_proxies grocery\necho services-replaced\n'], text=True, capture_output=True)
                if proxy:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('services-replaced', result.stdout)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    for name in ('ingress', 'tools', 'provider'):
                        self.assertIn(f'grocery run --rm --no-deps --entrypoint nginx assistant-{name} -t', result.stdout)
        start = source.split('start_store() {', 1)[1].split('\ninternal_ready()', 1)[0]
        self.assertLess(start.index('validate_assistant_proxies "$store"'), start.index('compose "$store" up -d'))


if __name__ == '__main__':
    unittest.main()
