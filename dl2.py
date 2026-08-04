import requests
import json

# Datei mit Zugangsdaten einlesen
def load_credentials(filename="access.txt"):
    credentials = {}
    with open(filename, "r") as file:
        for line in file:
            key, value = line.strip().split("=", 1)
            credentials[key] = value.strip()
    return credentials

# Zugangsdaten laden
creds = load_credentials()

# Camunda API-Konfiguration
CLIENT_ID = creds["CAMUNDA_CONSOLE_CLIENT_ID"]
CLIENT_SECRET = creds["CAMUNDA_CONSOLE_CLIENT_SECRET"]
OAUTH_URL = creds["CAMUNDA_OAUTH_URL"]
AUDIENCE = creds["CAMUNDA_CONSOLE_OAUTH_AUDIENCE"]

# Endpunkt für Benutzerliste
USERS_ENDPOINT = "https://api.cloud.camunda.io/members"

def get_access_token():
    """Holt ein OAuth2-Token von Camunda mit Debugging."""
    payload = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "audience": AUDIENCE
    }
    headers = {"Content-Type": "application/json"}
    
    print("📡 Sende Token-Request an:", OAUTH_URL)
    response = requests.post(OAUTH_URL, json=payload, headers=headers)

    if response.status_code == 200:
        token = response.json().get("access_token")
        print("✅ Token erfolgreich abgerufen!\n")
        return token
    else:
        print(f"❌ Fehler beim Abrufen des Tokens ({response.status_code}): {response.text}")
        return None

def get_users(token):
    """Holt alle Benutzer und filtert nach der Rolle 'developer'."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    print(f"📡 Sende API-Request an: {USERS_ENDPOINT}")
    response = requests.get(USERS_ENDPOINT, headers=headers)

    print("📥 HTTP-Statuscode:", response.status_code)
    
    if response.status_code == 200:
        users = response.json()
        print("✅ Benutzer erfolgreich abgerufen!\n")

        # Nur Benutzer mit der Rolle 'developer' anzeigen
        developer_users = [user for user in users if "developer" in user["roles"]]
        print("👨‍💻 **Anzahl Benutzer mit Rolle 'developer':**" + str(len(developer_users)))
        
        print("👨‍💻 **Benutzer mit Rolle 'developer':**")
        print(json.dumps(developer_users, indent=2))

    elif response.status_code == 403:
        print("❌ Fehler 403: Token hat nicht genug Berechtigungen.")
    elif response.status_code == 404:
        print("⚠️ Fehler 404: API-Endpunkt nicht gefunden. Ist die URL korrekt?")
    else:
        print(f"⚠️ Unerwarteter Fehler ({response.status_code}): {response.text}")

if __name__ == "__main__":
    token = get_access_token()
    if token:
        get_users(token)
    else:
        print("❌ Kein gültiges Token erhalten. Skript wird beendet.")
