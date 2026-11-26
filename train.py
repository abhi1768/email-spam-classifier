import os
import joblib
import pandas as pd

from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report

# Build paths from this file's location so the script works from any terminal folder
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "dataset", "emails.csv")
MODEL_DIR = os.path.join(BASE_DIR, "model")


def load_data(path):
    # --- Handle encoding errors: try utf-8 first, fall back to latin-1 ---
    try:
        df = pd.read_csv(path, encoding="utf-8")
    except UnicodeDecodeError:
        df = pd.read_csv(path, encoding="latin-1")

    # --- Case-insensitive column matching: normalise headers to lowercase ---
    df.columns = df.columns.str.strip().str.lower()
    label_col = next((c for c in ("category", "label", "v1", "class", "target", "spam") if c in df.columns), None)
    text_col = next((c for c in ("message", "text", "v2", "email", "body", "content") if c in df.columns), None)
    if label_col is None or text_col is None:
        raise ValueError(f"Could not find label/text columns. Your columns are: {list(df.columns)}")

    df = df[[label_col, text_col]].rename(columns={label_col: "label", text_col: "text"})

    # --- Handle missing values and duplicates ---
    df = df.dropna()
    df["text"] = df["text"].astype(str).str.strip()
    df = df[df["text"] != ""].drop_duplicates()  # duplicates would leak between train/test sets

    # --- Convert labels to numbers: spam = 1, ham/legitimate = 0 ---
    mapping = {"spam": 1, "1": 1, "1.0": 1, "ham": 0, "legitimate": 0, "0": 0, "0.0": 0}
    df["label"] = df["label"].astype(str).str.strip().str.lower().map(mapping)
    df = df.dropna(subset=["label"])  # drop rows with unrecognised labels
    df["label"] = df["label"].astype(int)
    return df


df = load_data(CSV_PATH)
print(f"Loaded {len(df)} emails  |  Spam: {df['label'].sum()}  |  Ham: {(df['label'] == 0).sum()}")

# 80% train / 20% test; stratify keeps the spam:ham ratio equal in both sets
X_train, X_test, y_train, y_test = train_test_split(
    df["text"], df["label"], test_size=0.2, random_state=42, stratify=df["label"]
)

# TF-IDF turns text into numbers: words that are frequent in one email but rare overall get higher weight.
# ngram_range=(1,2) uses single words and word pairs; stop_words removes filler words like "the", "is".
vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True)
X_train_vec = vectorizer.fit_transform(X_train)  # learn vocabulary ONLY from training data
X_test_vec = vectorizer.transform(X_test)        # reuse that vocabulary on test data

# Logistic Regression outputs a probability for each class; class_weight balances spam vs ham imbalance
model = LogisticRegression(max_iter=1000, class_weight="balanced")
model.fit(X_train_vec, y_train)

# Evaluate on emails the model has never seen
y_pred = model.predict(X_test_vec)
print(f"\nAccuracy: {accuracy_score(y_test, y_pred) * 100:.2f}%\n")
print(classification_report(y_test, y_pred, target_names=["Legitimate", "Spam"]))

# Save both objects: app.py needs the vectorizer AND the model to predict on new text
os.makedirs(MODEL_DIR, exist_ok=True)
joblib.dump(vectorizer, os.path.join(MODEL_DIR, "vectorizer.pkl"))
joblib.dump(model, os.path.join(MODEL_DIR, "model.pkl"))
print("Saved model/model.pkl and model/vectorizer.pkl")