(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleWorkflowText=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function display(value) {
    if(typeof value!=="string")return value;
    // Keep orchestration instructions in native history, with a concise chat
    // presentation. Only our complete, nonce-bearing suffix is collapsed.
    const start=value.indexOf("\n\n[Stepsemble Goal]\nObjective:");
    if(start>=0 && /\[\[STEPSEMBLE_GOAL:[a-f0-9-]{36}:(?:complete|blocked)\]\]/.test(value.slice(start)) && /This is turn \d+ of at most \d+\.$/.test(value)) value=value.slice(0,start);
    return value.replace(/\s*\[\[STEPSEMBLE_GOAL:[a-f0-9-]{36}:(?:complete|blocked)\]\]\s*$/," ").trimEnd();
  }
  return {display};
});
