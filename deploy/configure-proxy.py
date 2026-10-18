"""Add CamundaAdmin to the existing file provider without changing other routes."""
import datetime
import os
import pathlib
import yaml

target = pathlib.Path('/proxy/dynamic.yml')
original = target.read_text()
before = yaml.safe_load(original)
if 'camundaadmin' in before['http']['routers'] or 'camundaadmin' in before['http']['services']:
    raise SystemExit('CamundaAdmin-Route existiert bereits; bestehende Konfiguration gezielt prüfen.')
router = '''    camundaadmin:
      rule: "Host(`gpmpm.iwi.hsw.fhnw.ch`) && (Path(`/camundaadmin`) || PathPrefix(`/camundaadmin/`))"
      entryPoints: [websecure]
      service: camundaadmin
      priority: 200
      tls:
        certResolver: letsencrypt
'''
service = '''    camundaadmin:
      loadBalancer:
        servers:
          - url: "http://camundaadmin:3300"
'''
if original.count('  routers:\n') != 1 or original.count('  services:\n') != 1:
    raise SystemExit('Unerwartete Proxystruktur; keine Änderung ausgeführt.')
updated = original.replace('  routers:\n', '  routers:\n' + router, 1).replace('  services:\n', '  services:\n' + service, 1)
after = yaml.safe_load(updated)
assert after['http']['services']['camundaadmin']['loadBalancer']['servers'][0]['url'] == 'http://camundaadmin:3300'
del after['http']['routers']['camundaadmin']
del after['http']['services']['camundaadmin']
assert before == after, 'Andere Proxykonfiguration würde verändert'
backup = pathlib.Path('/backup') / ('traefik-before-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.yml')
backup.write_text(original)
backup.chmod(0o600)
# Keep the inode: Traefik has this exact file bind-mounted, not its directory.
with target.open('w') as output:
    output.write(updated)
    output.flush()
    os.fsync(output.fileno())
print('CamundaAdmin-Route ergänzt; andere Routen unverändert; Sicherung erstellt.')
