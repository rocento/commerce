"""HTTP overload responses and shared public-admission cookie budgets."""


def extend(paths):
    error = {'$ref': '#/components/schemas/Error'}
    delay = lambda seconds: {'description': 'Retry delay in seconds.', 'schema': {'type': 'integer', 'enum': [seconds]}}
    for path, methods in paths.items():
        # Liveness/readiness/metrics bypass the application concurrency budget.
        # Readiness keeps its own structured 503 dependency-status response.
        if path in ['/health', '/ready', '/metrics']:
            continue
        for operation in methods.values():
            response = operation['responses'].setdefault('503', {'description': ''})
            previous = response['description']
            response['description'] = ('Application admission is saturated or the pre-response handler deadline elapsed. '
                'Database admission or lock/statement budgets may also be exhausted. The gateway returns Retry-After: 3 for these overload responses. '
                'A timeout does not prove a mutation was rolled back; retain the operation\'s idempotency key and reconcile its receipt/state before retrying. '
                'Streaming responses have endpoint-specific limits after their headers are sent.' + (' ' + previous if previous else ''))
            response.setdefault('headers', {})['Retry-After'] = delay(3)
            content = response.setdefault('content', {})
            if 'application/json' not in content:
                content['application/json'] = {'schema': error}
            elif content['application/json'].get('schema') not in [None, error]:
                # An endpoint may have its own structured unavailable result.
                # Keep that contract as an alternative to the middleware error.
                previous_schema = content['application/json']['schema']
                content['application/json']['schema'] = {'anyOf': [previous_schema, error]}

    # Values mirror auth_ip::PublicAdmission::default. Installation totals may
    # be configured; customer/visitor and direct-peer allowances remain fixed.
    budgets = {
        'support': (20, 100, 2000, 'support_guest'),
        'assistant': (120, 480, 3000, 'assistant_visitor'),
        'memory': (120, 600, 12000, 'assistant_visitor'),
        'analytics': (1000, 4000, 100000, 'analytics_visitor'),
    }
    selected = {
        ('/v1/support/tickets', 'post'): 'support',
        ('/v1/assistant/chat', 'post'): 'assistant',
        ('/v1/analytics/events', 'post'): 'analytics',
    }
    selected.update({(path, method): 'memory' for path, methods in paths.items()
        if path == '/v1/assistant/memory' or path.startswith('/v1/assistant/memory/') for method in methods})
    for (path, method), service in selected.items():
        operation = paths[path][method]
        subject, source, aggregate, cookie = budgets[service]
        description = (f'Shared {service} admission over a 15-minute window: {subject} requests per customer or visitor; '
            f'{source} per direct connection source in peer mode; {aggregate} per installation by default. '
            f'The installation total is configurable with PUBLIC_{service.upper()}_TOTAL_LIMIT. '
            'Ingress mode delegates source throttling to trusted ingress; subject and installation limits remain shared in PostgreSQL across replicas. '
            f'A customer bearer identity is used when present and decodable; otherwise the opaque {cookie} cookie identifies the visitor. '
            'This admission identity grants no access: the endpoint still enforces its own authentication and live-session checks. '
            'Retain server-issued cookies for this installation; changing cookies does not bypass source or installation limits.')
        operation['description'] = '\n\n'.join(filter(None, [operation.get('description'), description]))
        operation['responses']['429'] = {
            'description': f'The {service} subject, source or installation allowance is exhausted. Retry after 900 seconds; admission does not invoke the handler.',
            'headers': {'Retry-After': delay(900)},
            'content': {'application/json': {'schema': error}},
        }
        operation.setdefault('parameters', []).append({
            'name': cookie, 'in': 'cookie', 'required': False,
            'schema': {'type': 'string', 'pattern': '^[A-Za-z0-9]{48}$'},
            'description': 'Opaque server-issued visitor cookie used for admission when no decodable customer bearer token is supplied. It is not a customer authentication credential.',
        })
        for status, response in operation['responses'].items():
            if status.startswith('2'):
                response.setdefault('headers', {})['Set-Cookie'] = {
                    'schema': {'type': 'string'},
                    'description': f'May issue {cookie} when an anonymous admitted request lacks a valid visitor cookie: HttpOnly, SameSite=Strict, Path=/, Max-Age=86400; Secure in secure-cookie deployments. Preserve other cookies returned by the endpoint.',
                }
