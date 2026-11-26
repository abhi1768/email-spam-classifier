import os
import base64
import html
import re
import joblib
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Read-only access: reads unread emails without modifying or moving them
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

CREDENTIALS_PATH = os.path.join(BASE_DIR, "credentials.json")
TOKEN_PATH = os.path.join(BASE_DIR, "token.json")
MODEL_PATH = os.path.join(BASE_DIR, "model", "model.pkl")
VECTORIZER_PATH = os.path.join(BASE_DIR, "model", "vectorizer.pkl")

SPAM_THRESHOLD = 0.68
SUSPICIOUS_THRESHOLD = 0.48


def get_gmail_service():
    if not os.path.exists(CREDENTIALS_PATH):
        raise FileNotFoundError(
            "credentials.json not found in project root. Download it from Google Cloud Console."
        )

    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w") as token:
            token.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def _extract_part_text(payload, target_mime):
    """Recursively searches MIME parts for a specific content type."""
    if payload.get("mimeType") == target_mime and "data" in payload.get("body", {}):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="ignore")

    for part in payload.get("parts", []):
        text = _extract_part_text(part, target_mime)
        if text:
            return text

    return ""


def get_email_body(payload):
    """Extracts plain text, or strips HTML tags if the email is HTML-only."""
    plain_text = _extract_part_text(payload, "text/plain")
    if plain_text.strip():
        return plain_text

    html_text = _extract_part_text(payload, "text/html")
    if html_text.strip():
        cleaned = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html_text)
        cleaned = re.sub(r"<[^>]+>", " ", cleaned)
        cleaned = html.unescape(cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()

    if "data" in payload.get("body", {}):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="ignore")

    return ""


def classify_text(text, model, vectorizer):
    """Classifies emails into Legitimate, Suspicious, or Spam to prevent false positives."""
    features = vectorizer.transform([text])
    spam_prob = float(model.predict_proba(features)[0][1])

    if spam_prob >= SPAM_THRESHOLD:
        return "Spam", round(spam_prob * 100, 2)
    elif spam_prob >= SUSPICIOUS_THRESHOLD:
        return "Suspicious", round(spam_prob * 100, 2)
    else:
        confidence = 0.5 + 0.5 * ((SUSPICIOUS_THRESHOLD - spam_prob) / SUSPICIOUS_THRESHOLD)
        return "Legitimate", round(confidence * 100, 2)


def scan_unread_emails(model=None, vectorizer=None, max_results=5):
    """Fetches unread Inbox messages and returns a list of classification results."""
    if model is None or vectorizer is None:
        model = joblib.load(MODEL_PATH)
        vectorizer = joblib.load(VECTORIZER_PATH)

    service = get_gmail_service()
    response = service.users().messages().list(
        userId="me", labelIds=["INBOX", "UNREAD"], maxResults=max_results
    ).execute()

    messages = response.get("messages", [])
    scanned_results = []

    for msg in messages:
        msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
        headers = msg_data.get("payload", {}).get("headers", [])

        subject = next((h["value"] for h in headers if h["name"].lower() == "subject"), "(No Subject)")
        sender = next((h["value"] for h in headers if h["name"].lower() == "from"), "Unknown Sender")
        body = get_email_body(msg_data.get("payload", {}))
        snippet = html.unescape(msg_data.get("snippet", ""))

        clean_body = (body or snippet).strip()
        full_text = f"{subject} {clean_body}".strip()
        label, confidence = classify_text(full_text, model, vectorizer)

        scanned_results.append({
            "id": msg["id"],
            "sender": sender,
            "subject": subject,
            "snippet": snippet,
            "body": clean_body[:4000],
            "label": label,
            "confidence": confidence,
        })

    return scanned_results


if __name__ == "__main__":
    results = scan_unread_emails()
    if not results:
        print("No unread emails found.")
    for item in results:
        print(f"[{item['label'].upper()} - {item['confidence']}%] {item['subject']}")