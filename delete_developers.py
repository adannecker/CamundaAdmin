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

# Endpunkte für Benutzerverwaltung
USERS_ENDPOINT = "https://api.cloud.camunda.io/members"
DELETE_USER_ENDPOINT = "https://api.cloud.camunda.io/members/{email}"  # Platzhalter für DELETE-Requests

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

def get_developer_users(token):
    """Holt alle Benutzer und filtert nach den Rollen 'developer' oder 'Developer'."""
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

        # Nur Benutzer mit der Rolle 'developer' oder 'Developer' auswählen
        developer_users = [user for user in users if any(role.lower() == "developer" for role in user["roles"])]
        
        if developer_users:
            print("👨‍💻 **Benutzer mit Rolle 'developer' oder 'Developer' (werden gelöscht):**")
            for user in developer_users:
                print(f"- {user['name']} ({user['email']})")
        else:
            print("✅ Keine 'developer'-Benutzer gefunden. Keine Aktion notwendig.")
        
        return developer_users

    elif response.status_code == 403:
        print("❌ Fehler 403: Token hat nicht genug Berechtigungen.")
    elif response.status_code == 404:
        print("⚠️ Fehler 404: API-Endpunkt nicht gefunden. Ist die URL korrekt?")
    else:
        print(f"⚠️ Unerwarteter Fehler ({response.status_code}): {response.text}")

    return []

def delete_user(token, email):
    """Löscht einen Benutzer anhand der E-Mail."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    delete_url = DELETE_USER_ENDPOINT.format(email=email)
    print(f"🗑️ Lösche Benutzer: {email}")

    response = requests.delete(delete_url, headers=headers)

    if response.status_code == 204:
        print(f"✅ Benutzer {email} erfolgreich gelöscht.")
    elif response.status_code == 403:
        print(f"❌ Fehler 403: Keine Berechtigung, um {email} zu löschen.")
    elif response.status_code == 404:
        print(f"⚠️ Fehler 404: Benutzer {email} nicht gefunden.")
    else:
        print(f"⚠️ Fehler {response.status_code}: {response.text}")

def delete_developer_users(token, users):
    """Löscht alle Benutzer mit der Rolle 'developer' oder 'Developer'."""
    if not users:
        print("✅ Keine Benutzer zu löschen.")
        return
    
    print("\n🗑️ Starte das Löschen von 'developer'-Benutzern...\n")
    for user in users:
        delete_user(token, user["email"])

if __name__ == "__main__":
    token = get_access_token()
    if token:
        developers = get_developer_users(token)
        delete_developer_users(token, developers)
    else:
        print("❌ Kein gültiges Token erhalten. Skript wird beendet.")
