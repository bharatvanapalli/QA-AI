'use strict';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function semanticKey(value) {
  const words = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const suffixNoise = new Set(['field', 'input', 'dropdown', 'select', 'selector', 'textbox', 'box', 'control']);
  while (words.length && suffixNoise.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function canonicalizeSemanticToken(token, { purpose = '', authContext = false } = {}) {
  const key = semanticKey(token) || norm(token);
  if (!key) return '';
  if (authContext || purpose === 'auth field') {
    if (key.includes('password') || key === 'pwd') return 'loginpassword';
    if (key.includes('username') || key.includes('userid') || key.includes('email') || key === 'user') return 'loginusername';
  }
  if (purpose === 'module gate field') {
    if (key.includes('password')) return 'modulegatepassword';
    return 'modulegatevalue';
  }
  const aliases = {
    username: 'usernamefilter',
    user: 'usernamefilter',
    usernamefield: 'usernamefilter',
    usernameinput: 'usernamefilter',
    usernamesearch: 'usernamefilter',
    usernamesearchfield: 'usernamefilter',
    usernamesearchinput: 'usernamefilter',
    usernamefilter: 'usernamefilter',
    usernamefilterfield: 'usernamefilter',
    usernamefilterinput: 'usernamefilter',
    usersearch: 'usernamefilter',
    usersearchfield: 'usernamefilter',
    userfilter: 'usernamefilter',
    userfilterfield: 'usernamefilter',
    userrole: 'userrolefilter',
    userrolefield: 'userrolefilter',
    userrolesearch: 'userrolefilter',
    userrolefilter: 'userrolefilter',
    userrolefilterfield: 'userrolefilter',
    role: 'userrolefilter',
    rolefield: 'userrolefilter',
    rolesearch: 'userrolefilter',
    rolefilter: 'userrolefilter',
    status: 'statusfilter',
    statusfield: 'statusfilter',
    statussearch: 'statusfilter',
    statusfilter: 'statusfilter',
    statusfilterfield: 'statusfilter',
    employeename: 'employeename',
    employeenamefield: 'employeename',
    employeenamesearch: 'employeename',
    employeenamefilter: 'employeename',
    employee: 'employeename',
    employeeid: 'employeeid',
    event: 'claimevent',
    eventfield: 'claimevent',
    claimevent: 'claimevent',
    currency: 'claimcurrency',
    currencyfield: 'claimcurrency',
    claimcurrency: 'claimcurrency',
    amount: 'claimamount',
    amountfield: 'claimamount',
    claimamount: 'claimamount',
    remarks: 'claimremarks',
    remarksfield: 'claimremarks',
    remark: 'claimremarks',
    claimremarks: 'claimremarks',
    firstname: 'firstname',
    middlename: 'middlename',
    lastname: 'lastname',
    fromdate: 'fromdate',
    todate: 'todate',
    leavetype: 'leavetype',
  };
  return aliases[key] || key;
}

function canonicalizeTokenExpression(value, context = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([^}]+?)\s*}}/g, (_match, rawToken) => {
    const canonical = canonicalizeSemanticToken(rawToken, context);
    return canonical ? `{{${canonical}}}` : `{{${clean(rawToken)}}}`;
  });
}

function textFromParts(parts) {
  return parts.map(clean).filter(Boolean).join(' ').toLowerCase();
}

function actionOf(step = {}) {
  return clean(step.action).toLowerCase();
}

function classifyFieldSemanticPurpose({ field, step = {}, caseContractPack = {}, capabilityMap = null, dataColumn } = {}) {
  const target = textFromParts([
    field,
    dataColumn,
    step.target,
    step.element,
    step.field,
    step.label,
    step.placeholder,
    caseContractPack.module,
    caseContractPack.pageIntent,
    caseContractPack.title,
  ]);
  const moduleName = norm(caseContractPack.module);
  const action = actionOf(step);
  const requiredFields = new Set((caseContractPack.requiredFields || []).map(norm));
  const isLoginFlow = /\blogin\b|\bsign\s*in\b|\bauth\b|\bcredential\b/.test(target);
  const isMaintenance = moduleName.includes('maintenance') || /\bmaintenance\b/.test(target);

  if (isMaintenance && /password/.test(target)) return 'module gate field';
  if (isLoginFlow && (/username|user\s*name|email|login\s*id/.test(target) || /password/.test(target))) return 'auth field';
  if (/password/.test(target) && !/\bsearch\b|\bfilter\b/.test(target)) return 'auth field';
  if (/\bsearch\b|\bfilter\b/.test(target) || /username|user\s*name|role|status|employee\s*name/.test(target) && (requiredFields.has('username') || requiredFields.has('role') || requiredFields.has('status'))) {
    return /verify|assert|see/.test(action) ? 'oracle field' : 'business search field';
  }
  if (/validat|required|invalid|error|message/.test(target)) return 'validation field';
  if (/verify|assert|see/.test(action)) return 'oracle field';
  if (/select|choose|fill|type|input|enter|check|upload/.test(action)) return 'create/update field';

  if (capabilityMap && Array.isArray(capabilityMap.fields)) {
    const matched = capabilityMap.fields.find((cap) => norm(cap.label) && target.includes(norm(cap.label)));
    if (matched && /search|filter/i.test(`${matched.label} ${matched.id || ''}`)) return 'business search field';
  }
  return 'create/update field';
}

function semanticTokenForPurpose(purpose, field) {
  const key = semanticKey(field) || norm(field);
  if (purpose === 'auth field') {
    if (key.includes('password')) return 'loginpassword';
    return 'loginusername';
  }
  if (purpose === 'module gate field') {
    if (key.includes('password')) return 'modulegatepassword';
    return 'modulegatevalue';
  }
  return canonicalizeSemanticToken(key, { purpose }) || 'value';
}

function isAuthBusinessCollision(step = {}, lineage = null, semanticPurpose = '') {
  const value = typeof step.value === 'string'
    ? step.value
    : (typeof step.text === 'string' ? step.text : (typeof step.input === 'string' ? step.input : ''));
  if (!/\{\{\s*(?:username|password|loginusername|loginpassword)\s*}}/i.test(value)) return false;
  if (semanticPurpose === 'auth field') return false;
  if (lineage && norm(lineage.sheetName) === 'executionprofile' && semanticPurpose === 'auth field') return false;
  return true;
}

module.exports = {
  classifyFieldSemanticPurpose,
  semanticTokenForPurpose,
  canonicalizeSemanticToken,
  canonicalizeTokenExpression,
  isAuthBusinessCollision,
};
