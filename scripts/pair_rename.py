import json

filename = "backend/data/clip_pairs.json"
with open(filename, "r") as f:
    data = json.load(f)

for item in data:
    item["left_clip"] = "videos/" + item["left_clip"]
    item["right_clip"] = "videos/" + item["right_clip"]

with open(filename, "w") as f:
    json.dump(data, f, indent=2)

print(f"Updated file saved in-place: {filename}")
