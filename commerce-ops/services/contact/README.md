# Contact service

This package owns the contact form's Python HTTP handler, its systemd unit, and
the standalone host activation script. The full platform deployment installs
`server.py` as `/opt/rocento-contact/server.py` and the unit as
`/etc/systemd/system/rocento-contact.service`; it reads SMTP settings from the
protected `/etc/rocento/contact.env` file.

The managed source upload includes this directory so the host installer has
the handler and unit it requires. `activate.sh` remains a separate staged
website/contact operation; it is not run by the full platform deployment.
Contact handler tests live in `commerce-ops/tests/operations/test_contact*.py`.
