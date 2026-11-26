import os
import joblib
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from gmail_scanner import scan_unread_emails, classify_text

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)  # Flask auto-detects the templates/ and static/ folders

# Allow the browser extension to send requests to this local Flask server
CORS(app)

# Load the trained objects once at startup (not on every request)
MODEL_PATH = os.path.join(BASE_DIR, "model", "model.pkl")
VECTORIZER_PATH = os.path.join(BASE_DIR, "model", "vectorizer.pkl")

if not os.path.exists(MODEL_PATH) or not os.path.exists(VECTORIZER_PATH):
    raise FileNotFoundError(
        "Model files not found. Run 'python train.py' first to generate model/model.pkl and model/vectorizer.pkl."
    )

model = joblib.load(MODEL_PATH)
vectorizer = joblib.load(VECTORIZER_PATH)


@app.route("/")
def home():
    # Serves the redesigned frontend
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    # Simple endpoint to verify the local server is running
    return jsonify({"status": "ok"})


@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip()
    if not email:
        return jsonify({"error": "Please enter some email text."}), 400

    # Uses the exact same 3-tier thresholds (Spam / Suspicious / Legitimate) as gmail_scanner.py
    label, confidence = classify_text(email, model, vectorizer)

    return jsonify({
        "label": label,
        "confidence": confidence,
    })


@app.route("/scan-gmail", methods=["GET"])
def scan_gmail():
    try:
        max_results = request.args.get("max_results", default=5, type=int)
        max_results = max(1, min(max_results, 20))
        results = scan_unread_emails(model=model, vectorizer=vectorizer, max_results=max_results)
        return jsonify({
            "count": len(results),
            "results": results,
        })
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Gmail scan failed: {str(e)}"}), 500


if __name__ == "__main__":
    # Explicit host and port match the extension's API URL (http://127.0.0.1:5000/predict)
    app.run(host="127.0.0.1", port=5000, debug=True)