from pathlib import Path
import secrets

path = Path('.env')
if not path.exists():
    path.write_text(Path('.env.example').read_text())
text = path.read_text()
values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#'))
for key, default in [('CLOUD_ADMIN_USERNAME', 'admin'), ('CLOUD_ADMIN_PASSWORD', secrets.token_urlsafe(32))]:
    if not values.get(key) or values[key].startswith('replace-'):
        lines = text.splitlines()
        entry = f'{key}={default}'
        if key in values:
            lines = [entry if line.startswith(key + '=') else line for line in lines]
        else:
            lines.append(entry)
        text = '\n'.join(lines) + '\n'
path.write_text(text)
path.chmod(0o600)
print('Cloud account bootstrap is configured in .env; credentials are not printed.')
