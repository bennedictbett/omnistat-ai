import json
import os
import re

def load_json_with_comments(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    # Remove single-line comments
    content = re.sub(r'//.*', '', content)
    # Remove trailing commas before ] or }
    content = re.sub(r',\s*([}\]])', r'\1', content)
    return json.loads(content)

# Load both files
batch1 = load_json_with_comments('data/training/statistical_intents.json')
batch2 = load_json_with_comments('data/training/statistical_intents_v2.json')

# Merge
merged = batch1 + batch2

# Remove duplicates based on query
seen = set()
unique = []
for item in merged:
    if item['query'] not in seen:
        seen.add(item['query'])
        unique.append(item)

print(f"Batch 1: {len(batch1)} examples")
print(f"Batch 2: {len(batch2)} examples")
print(f"Total merged: {len(merged)} examples")
print(f"After deduplication: {len(unique)} examples")

# Save merged file
os.makedirs('data/training', exist_ok=True)
with open('data/training/training_dataset.json', 'w') as f:
    json.dump(unique, f, indent=2)

print(f"\n✅ Saved to data/training/training_dataset.json")

# Show category breakdown
categories = {}
for item in unique:
    test = item['intent']['test']
    category = test.split('_')[0]
    categories[category] = categories.get(category, 0) + 1

print("\nCategory breakdown:")
for cat, count in sorted(categories.items(), key=lambda x: x[1], reverse=True):
    print(f"  {cat}: {count}")