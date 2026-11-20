#!/usr/bin/python3
"""Private provisioning failure alerts; destination comes only from root config."""
import fcntl
import json
import os
from pathlib import Path
import smtplib
import ssl
import subprocess
import sys
import tempfile
from email.message import EmailMessage
from email.utils import make_msgid

CONFIG = Path('/etc/rocento/merchant-provisioning')
STATE = Path('/opt/rocento-onboarding/alerts')


def write_state(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.deliveries-', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def send(subject, body, smtp, destination):
    message = EmailMessage()
    message['From'] = smtp['NOTIFICATION_FROM']
    message['To'] = destination
    message['Subject'] = subject
    message['Message-ID'] = make_msgid(domain='rocento.com')
    message.set_content(body)
    port = int(smtp['SMTP_PORT'])
    context = ssl.create_default_context()
    if port == 465:
        connection = smtplib.SMTP_SSL(smtp['SMTP_HOST'], port, context=context, timeout=20)
    elif port == 587:
        connection = smtplib.SMTP(smtp['SMTP_HOST'], port, timeout=20)
        connection.ehlo(); connection.starttls(context=context); connection.ehlo()
    else:
        raise ValueError('Unsupported secure SMTP port')
    with connection:
        connection.login(smtp['SMTP_USERNAME'], smtp['SMTP_PASSWORD'])
        connection.send_message(message)
    return message['Message-ID']


def main():
    os.umask(0o077)
    settings = json.loads((CONFIG/'alerts.json').read_text())
    destination = settings['recipient']
    if not isinstance(destination, str) or any(c in destination for c in '\r\n,;') or destination.count('@') != 1:
        raise ValueError('Invalid operator recipient')
    smtp = json.loads((CONFIG/'smtp.json').read_text())
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE/'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = STATE/'deliveries.json'
        prior = json.loads(path.read_text()) if path.exists() else {}
        if sys.argv[1:] == ['--test']:
            pending = [('test-setup-20261112', 'Rocento provisioning alert test',
                        'This is the authorized one-time AWS provisioning alert test.\n'
                        'Future terminal provisioning failures will be reported here.\n'
                        'This message does not mean the test store is active.\n')]
        elif not sys.argv[1:]:
            query = "SELECT COALESCE(json_agg(json_build_object('id',j.id,'slug',t.store_slug,'reason',j.last_error)), '[]'::json) FROM provisioning_jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.status='FAILED';"
            raw = subprocess.check_output(['docker','exec','-i','rocento-onboarding-test-postgres-1','psql','-v','ON_ERROR_STOP=1','-U','onboarding','-d','onboarding','-At'],input=query.encode(),timeout=10)
            pending = [('job:'+j['id'], 'Rocento store setup needs review',
                        f"Store: {j['slug']}.rocento.com\nJob: {j['id']}\nReason: {j['reason']}\n"
                        'Inspect the private provisioning journal before retrying. No automatic redeployment is authorized by this alert.\n')
                       for j in json.loads(raw)]
            service = subprocess.run(['systemctl','is-active','--quiet','rocento-merchant-worker.service'],check=False)
            if service.returncode:
                pending.append(('worker-down','Rocento provisioning worker is unavailable','Inspect systemctl status rocento-merchant-worker.service and its journal.\n'))
            else:
                prior.pop('worker-down',None)
        else:
            raise ValueError('Unsupported argument')
        for key, subject, body in pending:
            if key in prior:
                continue
            # SMTP timeout is ambiguous. Retain in-flight status for operator
            # reconciliation instead of automatically sending duplicate mail.
            prior[key]={'status':'in-flight'}
            write_state(path, prior)
            message_id=send(subject,body,smtp,destination)
            prior[key]={'status':'accepted-by-smtp','messageId':message_id}
            write_state(path, prior)
            print(json.dumps({'alert':key,'status':'accepted-by-smtp','messageId':message_id}))
        write_state(path, prior)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No credentials, SMTP transcripts or connection strings in journal.
        print('Provisioning alert failed: '+type(error).__name__,file=sys.stderr)
        sys.exit(1)
