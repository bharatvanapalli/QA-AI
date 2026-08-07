'use strict';

function cleanLabel(raw) {
  return String(raw || '')
    .replace(/^\s*(click|enter|select|choose|check|type|input|press|hover|drag|drop|confirm|verify|assert)\s+(the|a|an)?\s*/i, '')
    .replace(/\b(confirm|verify|assert|should|expect|validate|check|alert|field|button|input|box|text)\b/gi, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .trim() || 'Target Element';
}

function extractTargetAndValue(cleanText) {
  const matches = [...cleanText.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  let value = null;
  let targetLabel = null;

  if (matches.length >= 2) {
    value = matches[0];
    targetLabel = matches[1];
  } else if (matches.length === 1) {
    if (/\b(enter|type|input|append|fill|select|choose)\b/i.test(cleanText)) {
      value = matches[0];
      const prepMatch = cleanText.match(/\b(?:in|on|for|at|into)\b\s+(?:the\s+)?([^".]+)/i);
      targetLabel = prepMatch ? prepMatch[1].trim() : matches[0];
    } else {
      targetLabel = matches[0];
    }
  } else {
    targetLabel = cleanText;
  }

  return {
    value,
    targetLabel: cleanLabel(targetLabel),
  };
}

const sampleSentences = [
  'Enter "Ada Lovelace" in the "Enter your full Name" field.',
  'Append " and I enjoy automation" to the field whose current value is "I am good".',
  'Read the value from the "What is inside the text box" field.',
  'Clear the "Clear the text" field.',
  'Click the "Goto Home" button.',
  'Select "Apple" from the fruit dropdown.',
];

console.log('Testing Target & Value Extraction:');
sampleSentences.forEach((s) => {
  console.log(`\nSentence: "${s}"`);
  console.log('Result:', extractTargetAndValue(s));
});
