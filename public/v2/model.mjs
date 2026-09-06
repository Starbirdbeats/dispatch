export const templates = [
  { id: 'ship', name: 'Ship a feature', category: 'Engineering', description: 'Turn a brief into a reviewed, tested change.', stages: ['Plan', 'Build', 'Review', 'Approve'], prompts: ['Read the brief and inputs. Write a scoped plan with acceptance criteria.', 'Implement the accepted plan. Run the relevant tests and record the results.', 'Review the changes independently against the acceptance criteria. Return specific findings.', 'Review the collected evidence and approve the result.'], gates: ['An actionable plan covers every acceptance criterion.', 'Implementation is complete and the relevant tests pass.', 'No unresolved high or medium findings remain.', 'A human approves the final result.'] },
  { id: 'research', name: 'Research a question', category: 'Research', description: 'Gather sources, challenge findings, deliver an answer.', stages: ['Scope', 'Research', 'Fact-check', 'Deliver'], prompts: ['Define the question, required sources, and boundaries.', 'Collect primary sources. Record links and distinguish facts from inference.', 'Verify the claims against their sources. Identify contradictions and gaps.', 'Present a concise answer with citations and limitations.'], gates: ['The research question and boundaries are explicit.', 'Every major finding has a traceable source.', 'Claims are supported and contradictions are addressed.', 'The answer addresses the original question with evidence.'] },
  { id: 'design', name: 'Improve a design', category: 'Design', description: 'Build, compare, and refine against a clear reference.', stages: ['Brief', 'Design', 'Critique', 'Approve'], prompts: ['Describe the audience, task, reference, and success criteria.', 'Build the experience for mobile first. Exercise the main interactions.', 'Compare the working artifact against the brief and reference. List concrete gaps.', 'Review desktop and mobile evidence and approve the result.'], gates: ['The audience, reference, and acceptance criteria are defined.', 'The primary flow works on mobile and desktop.', 'The artifact meets the brief with no blocking usability findings.', 'A human approves the final design.'] },
  { id: 'blank', name: 'Start from scratch', category: 'Your workflow', description: 'Define the work, the check, and the way forward.', stages: ['Build', 'Check'], prompts: ['Produce the requested result using the supplied inputs.', 'Check the result against the goal. Explain any unmet requirements.'], gates: ['The requested output exists with evidence.', 'Every acceptance criterion passes.'] },
];
export const uid = () => {
  // randomUUID needs a secure context; LAN HTTP still exposes getRandomValues.
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (b, i) => `${[4,6,8,10].includes(i)?'-':''}${b.toString(16).padStart(2,'0')}`).join('');
};
export function makeStages(templateId, human = true, limit = 3) {
  const template = templates.find(t => t.id === templateId) || templates[0];
  const stages = template.stages.map((name, i) => ({ id: uid(), name, prompt: template.prompts[i], gate: template.gates[i], checker: 'review', agent: i % 2 ? 'Codex' : 'Claude', maxAttempts: limit, failTarget: '', status: 'pending', attempts: 0, evidence: [] }));
  stages.forEach((s, i) => { s.failTarget = stages[Math.max(0, i - 1)].id; });
  stages.at(-1).checker = human ? 'human' : 'review';
  return stages;
}
export function createTicket({ title, goal, inputs = '', template = 'ship', human = true, limit = 3 }) {
  return { id: uid(), title: title.trim(), goal: goal.trim(), inputs: inputs.trim(), template, columnId: 'backlog', state: 'draft', createdAt: new Date().toISOString(), stages: makeStages(template, human, limit), events: [], run: 0 };
}
export function initialData() {
  const ticket = createTicket({title:'Build a better onboarding flow',goal:'Help a new user create and run their first workflow on a phone, without needing to understand graphs.',inputs:'Mobile first. Show gate evidence and make human approvals explicit.',template:'design'});
  ticket.example = true; ticket.number = 1;
  return { version: 2, columns: [{id:'backlog', name:'Backlog', kind:'backlog'}, {id:'progress', name:'In progress',kind:'progress'}, {id:'attention',name:'Needs you',kind:'attention'}, {id:'completed',name:'Completed',kind:'completed'}], tickets:[ticket] };
}
export function validateTicket(t) {
  const errors = [];
  if (!t.title.trim()) errors.push('Give this ticket a title.');
  if (!t.goal.trim()) errors.push('Describe the finished outcome.');
  if (!t.stages.length) errors.push('Add at least one stage.');
  const ids = new Set(t.stages.map(s => s.id));
  for (const s of t.stages) {
    if (!s.name.trim() || !s.prompt.trim() || !s.gate.trim()) errors.push(`${s.name || 'Unnamed stage'} needs a name, instructions, and a pass condition.`);
    if (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 20) errors.push(`${s.name}: set an attempt limit between 1 and 20.`);
    if (!ids.has(s.failTarget) || t.stages.findIndex(x => x.id === s.failTarget) > t.stages.indexOf(s)) errors.push(`${s.name}: choose this stage or an earlier stage as the failure destination.`);
  }
  return errors;
}
function event(t, text) { t.events.unshift({ at: new Date().toISOString(), text }); }
function current(t) { return t.stages.find(s => s.status !== 'passed'); }
export function transition(input, action) {
  const t = structuredClone(input);
  if (action === 'start') {
    if (!['draft','completed'].includes(t.state)) throw new Error('This run has already started.');
    const errors = validateTicket(t); if (errors.length) throw new Error(errors[0]);
    t.run++; t.state = 'running'; t.columnId = 'progress';
    t.stages.forEach(s => { s.status = 'pending'; s.attempts = 0; s.evidence = []; });
    event(t, `Test run ${t.run} started. Results are simulated; no agents or commands are executed.`);
  } else if (action === 'pause') {
    if (t.state !== 'running') throw new Error('Only a running workflow can be paused.');
    t.state = 'paused'; event(t, 'Test run paused.');
  } else if (action === 'resume') {
    if (t.state !== 'paused') throw new Error('Only a paused workflow can resume.');
    t.state = 'running'; event(t, 'Test run resumed.');
  } else if (action === 'tick') {
    if (t.state !== 'running') return t;
    const s = current(t);
    if (!s) return t;
    if (s.attempts >= s.maxAttempts && s.status !== 'running') {
      t.state = 'blocked'; t.columnId = 'attention'; event(t, `${s.name}: attempt limit reached. Revise the graph before another run.`); return t;
    }
    if (s.status === 'pending') {
      s.attempts++; s.status = 'running'; event(t, `${s.name}: test attempt ${s.attempts}/${s.maxAttempts} started.`);
    } else if (s.status === 'running') {
      if (s.checker === 'human') {
        s.status = 'waiting'; t.state = 'waiting'; t.columnId = 'attention';
        s.evidence.push({ at: new Date().toISOString(), result:'waiting', text:`Simulated output ready. Human decision required: ${s.gate}` });
        event(t, `${s.name}: waiting for your approval.`);
      } else { pass(t, s); }
    }
  } else if (action === 'approve') {
    const s = current(t); if (t.state !== 'waiting' || s?.status !== 'waiting') throw new Error('There is no approval waiting.');
    pass(t, s);
  } else if (action === 'fail') {
    const s = current(t);
    if (!['running','waiting'].includes(t.state) || !['running','waiting'].includes(s?.status)) throw new Error('Wait for a stage to run before rejecting its gate.');
    s.evidence.push({at:new Date().toISOString(),result:'failed',text:'Test failure injected by the user. No real verification was performed.'});
    const target = t.stages.findIndex(x => x.id === s.failTarget);
    event(t, `${s.name}: gate failed. Return to ${t.stages[target].name}.`);
    if (s.attempts >= s.maxAttempts) { s.status='failed'; t.state='blocked';t.columnId='attention';event(t,`${s.name}: attempt limit reached. Run stopped.`); }
    else { t.stages.slice(target).forEach(x => {x.status='pending';}); t.state='running';t.columnId='progress'; }
  } else if (action === 'edit') {
    if (t.state === 'running') throw new Error('Pause the test run before editing.');
    t.state='draft';t.columnId='backlog';t.stages.forEach(s=>{s.status='pending';s.attempts=0;});
    event(t,'Returned to draft. Previous test evidence retained until the next run.');
  } else throw new Error('Unknown run action.');
  return t;
}
function pass(t,s) {
  s.status='passed'; s.evidence.push({at:new Date().toISOString(),result:'passed',text:s.checker==='human'?'Approved by the user in test mode.':'Simulated gate pass. This demonstrates routing only; no real tests or reviews ran.'});
  event(t,`${s.name}: ${s.checker==='human'?'human approved':'simulated gate passed'}.`);
  const done=t.stages.every(x=>x.status==='passed');t.state=done?'completed':'running';t.columnId=done?'completed':'progress';
  if(done) event(t,'Test run completed. All gates passed in test mode.');
}
