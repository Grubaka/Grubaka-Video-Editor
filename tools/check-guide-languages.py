"""Check that every Russian guide string has its English counterpart in guide.html."""
from html.parser import HTMLParser
from pathlib import Path
import json
import re


class GuideParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ignored = None
        self.translation_json = []
        self.strings = set()
        self.images = []
        self.localized_nodes = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self.ignored = "translations" if attrs.get("id") == "guide-translations" else tag
            return
        if self.ignored:
            return
        for name in ("title", "alt", "aria-label", "placeholder", "data-keywords"):
            self.add(attrs.get(name, ""))
        if tag == "img":
            self.images.append(attrs["src"])
        if "data-guide-en" in attrs or "data-guide-ru" in attrs:
            self.localized_nodes += 1
            for language in ("ru", "en"):
                localized = json.loads(attrs["data-guide-" + language])
                if not isinstance(localized, dict) or not localized:
                    raise ValueError("Invalid localized illustration attributes")
                if tag == "img":
                    self.images.append(localized["src"])

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.ignored = None

    def handle_data(self, data):
        if self.ignored == "translations":
            self.translation_json.append(data)
        elif not self.ignored:
            self.add(data)

    def add(self, value):
        if re.search("[А-Яа-яЁё]", value):
            self.strings.add(value)


guide = Path(__file__).resolve().parents[1] / "editor" / "guide.html"
parser = GuideParser()
parser.feed(guide.read_text(encoding="utf-8"))
translations = json.loads("".join(parser.translation_json))["en"]
missing = parser.strings - translations.keys()
if missing:
    raise SystemExit("Missing English translations:\n" + "\n".join(sorted(missing)))
if any(not isinstance(value, str) or not value.strip() for value in translations.values()):
    raise SystemExit("Empty or invalid English translation")
for image in set(parser.images):
    if not (guide.parent / image).is_file():
        raise SystemExit("Missing guide image: " + image)
print(f"Guide OK: {len(parser.strings)} Russian strings have English translations; {len(set(parser.images))} images exist; {parser.localized_nodes} illustration elements have both languages.")
