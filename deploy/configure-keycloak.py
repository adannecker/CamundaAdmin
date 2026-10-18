"""Create only this application's OIDC client; never print any credentials."""
import json
import os
import pathlib
import urllib.parse
import urllib.request

PUBLIC = 'https://gpmpm.iwi.hsw.fhnw.ch'
BASE = PUBLIC + '/keycloak'
REALM = 'fhnw'
EMAIL = 'achim.dannecker@fhnw.ch'
MARKER = 'Managed CamundaAdmin AAI owner-only login'
OUT = pathlib.Path('/output')


def request(method, url, data=None, token=None, form=False):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        data = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=30) as response:
        body = response.read()
        return json.loads(body) if body else None


def main():
    token = request('POST', BASE + '/realms/master/protocol/openid-connect/token', {
        'client_id': 'admin-cli', 'grant_type': 'password',
        'username': os.environ['KC_BOOTSTRAP_ADMIN_USERNAME'], 'password': os.environ['KC_BOOTSTRAP_ADMIN_PASSWORD'],
    }, form=True)['access_token']
    admin = BASE + '/admin/realms/' + REALM
    provider = request('GET', admin + '/identity-provider/instances/switch-eduid', token=token)
    if not provider.get('enabled'):
        raise ValueError('AAI-Anbieter ist nicht aktiv')
    users = request('GET', admin + '/users?' + urllib.parse.urlencode({'email': EMAIL, 'exact': 'true'}), token=token)
    users = [u for u in users if u.get('email', '').lower() == EMAIL]
    if len(users) != 1 or not users[0].get('enabled') or not users[0].get('emailVerified'):
        raise ValueError('Owner muss eindeutig, aktiv und mit bestätigter E-Mail vorhanden sein')
    owner = users[0]
    identities = request('GET', admin + '/users/' + owner['id'] + '/federated-identity', token=token)
    if not any(i.get('identityProvider') == 'switch-eduid' for i in identities):
        raise ValueError('Owner besitzt noch keine verknüpfte AAI-Identität')
    clients = request('GET', admin + '/clients?clientId=camundaadmin', token=token)
    if len(clients) > 1 or (clients and clients[0].get('description') != MARKER):
        raise ValueError('Bestehender Client gehört nicht zu dieser Einrichtung')
    spec = {
        'clientId': 'camundaadmin', 'name': 'Camunda Admin', 'description': MARKER, 'enabled': True,
        'protocol': 'openid-connect', 'publicClient': False, 'bearerOnly': False,
        'standardFlowEnabled': True, 'implicitFlowEnabled': False, 'directAccessGrantsEnabled': False,
        'serviceAccountsEnabled': False, 'fullScopeAllowed': False,
        'redirectUris': [PUBLIC + '/camundaadmin/auth/callback'], 'webOrigins': [PUBLIC],
        'rootUrl': PUBLIC + '/camundaadmin/', 'baseUrl': '/camundaadmin/',
        'attributes': {'pkce.code.challenge.method': 'S256'},
        'defaultClientScopes': ['basic', 'profile', 'email'], 'optionalClientScopes': [],
        'protocolMappers': [{
            'name': 'camundaadmin-aai-provider', 'protocol': 'openid-connect',
            'protocolMapper': 'oidc-usersessionmodel-note-mapper',
            'config': {'user.session.note': 'identity_provider', 'claim.name': 'identity_provider',
                       'jsonType.label': 'String', 'id.token.claim': 'true', 'access.token.claim': 'false', 'userinfo.token.claim': 'false'},
        }],
    }
    if not clients:
        request('POST', admin + '/clients', spec, token=token)
        clients = request('GET', admin + '/clients?clientId=camundaadmin', token=token)
    # Keep an existing managed client's secret stable when rerunning.
    client_id = clients[0]['id']
    request('PUT', admin + '/clients/' + client_id, spec, token=token)
    secret = request('GET', admin + '/clients/' + client_id + '/client-secret', token=token)['value']
    values = {'AUTH_MODE': 'oidc', 'HOST': '0.0.0.0', 'PORT': '3300', 'BASE_PATH': '/camundaadmin',
              'PUBLIC_URL': PUBLIC + '/camundaadmin', 'OIDC_ISSUER': BASE + '/realms/' + REALM,
              'OIDC_CLIENT_ID': 'camundaadmin', 'OIDC_CLIENT_SECRET': secret,
              'OIDC_OWNER_SUB': owner['id'], 'OIDC_OWNER_EMAIL': EMAIL,
              'CAMUNDA_DATA_DIR': '/app/data', 'PYTHON_BIN': '/usr/bin/python3', 'NODE_ENV': 'production'}
    target = OUT / 'auth.env'
    target.write_text(''.join(key + '=' + value + '\n' for key, value in values.items()))
    target.chmod(0o600)
    print(json.dumps({'ok': True, 'client': 'camundaadmin', 'owner': EMAIL, 'aaiLinked': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider response bodies and tokens must never enter console logs.
        print('Keycloak-Einrichtung fehlgeschlagen: ' + type(error).__name__)
        raise SystemExit(1)
