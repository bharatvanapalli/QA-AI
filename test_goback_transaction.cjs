const { createTypedAdapterPlan } = require('./server/services/controllerTypedAdapterRegistry');

async function run() {
  const operation = {
    kind: 'action',
    type: 'GoBack',
    operationId: 'action:123',
    actionOccurrenceId: 'occ:1'
  };
  
  try {
    const p = createTypedAdapterPlan({ operation, resolution: { status: 'RESOLVED', target: { synthetic: true }, factRefs: [] } });
    console.log('Plan Proof Contract:', JSON.stringify(p.proofContract, null, 2));
  } catch (e) {
    console.error('Plan Error:', e.code, e.message);
  }
}
run();
