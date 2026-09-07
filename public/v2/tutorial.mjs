// Progress follows the real editor and run, not a separate simulation.
export function tutorialStep(tour, wizard, ticket) {
  if (!tour) return null;
  if (!tour.ticketId) return {
    index: Math.min(2, wizard?.step || 0),
    title: ['Choose a workflow', 'Describe the result', 'Set a stopping point'][wizard?.step || 0],
    text: [
      'Choose a template below, then Continue. The practice example is filled in for you.',
      'Edit the practice title and outcome, or keep them. Describe something you can check, then Continue.',
      'Keep at least 3 attempts and human approval enabled to practice a retry and a decision. Create the ticket when ready.'
    ][wizard?.step || 0], target: '#wizard-form'
  };
  if (!ticket) return null;
  if (ticket.state === 'paused') return {index:5,title:'Resume when you are ready',text:'Your test run was paused. Choose Resume run, then advance each step yourself. No agents run during this tutorial.',target:'.workspace-actions'};
  if (ticket.state === 'draft') return {index:3,title:'Give the stage a job and a gate',text:'Select a stage. Review its prompt, agent, model, effort and speed. Set observable proof, who checks it, and where failure returns. Save the stage, then Start test run.',target:'#inspector'};
  if (ticket.state === 'completed') return {index:6,title:'Your workflow reached the finish',text:'Every gate passed in test mode. Open Tickets to see it in Completed. This proves the route only, not real agent work.',target:'.workspace-head',done:true};
  const failed = ticket.events.some(e=>e.text.includes('gate failed'));
  if (!failed) return {index:4,title:'Try the return path',text:'Use Advance one step until a stage is running, then Inject failure. Watch the activity log show where the loop returns. Tutorial runs advance only when you click.',target:'.run-banner'};
  return {index:5,title:'Finish the loop and check the evidence',text:'Use Advance one step to retry and pass each stage. When a human gate waits, inspect its simulated evidence and approve it. If you stopped the run, return to draft and try again.',target:'.run-banner'};
}
