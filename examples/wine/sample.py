# The cookbook's load_slice(1200, 800, seed=0), same logic, written to data/wine.json.
# Python's seeded shuffle is what makes the sample identical to the cookbook's.
import csv, io, json, os, random, urllib.request
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)
URL = "https://huggingface.co/datasets/GroNLP/ik-nlp-22_winemag/resolve/90eb39f35fc64e556fc17f06d4137a4a69ec3297/train.csv"
req = urllib.request.Request(URL, headers={"User-Agent": "typesafe-cookbook/1.0"})
text = urllib.request.urlopen(req, timeout=300).read().decode()
rows, seen = [], set()
for row in csv.DictReader(io.StringIO(text)):
    if not row["description"] or not row["points"] or row["description"] in seen:
        continue
    seen.add(row["description"])
    rows.append((row["description"], float(row["points"])))
random.Random(0).shuffle(rows)
picked = rows[:2000]
json.dump({"notes": [r[0] for r in picked], "points": [r[1] for r in picked]}, open(os.path.join(OUT, "wine.json"), "w"))
import statistics as s
p = [r[1] for r in picked]
print(len(picked), min(p), max(p), round(s.mean(p), 2), round(s.pstdev(p), 2))
print(picked[0][0][:200])
