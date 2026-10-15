(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleWorkflowText=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function display(value) {
    if(typeof value!=="string")return value;
    // Keep orchestration instructions in native history, with a concise chat
    // presentation. Only our complete, nonce-bearing suffix is collapsed.
    const start=value.indexOf("\n\n[Stepsemble Goal]\nObjective:");
    if(start>=0 && /\[\[STEPSEMBLE_GOAL:[a-f0-9-]{36}:(?:complete|blocked)\]\]/.test(value.slice(start)) && /This is turn \d+ of at most \d+\.$/.test(value)) value=value.slice(0,start);
    // Agents often wrap the final marker in Markdown or add punctuation.
    const marker="\\[\\[STEPSEMBLE_GOAL:[a-f0-9-]{36}:(?:complete|blocked)\\]\\]";
    return value.replace(new RegExp("\\s*```[\\w-]*[ \\t]*\\n[ \\t]*"+marker+"[ \\t]*\\n[ \\t]*```\\s*$"),"")
      .replace(new RegExp("\\s*[>`*_~\"'\u201c\u201d\u2018\u2019]*[ \\t]*"+marker+"[`*_~\"'\u201c\u201d\u2018\u2019.,;:!?\u3002\uff0c\uff0e\uff01\uff1f\u3001)\\]\uff09\u3011\u300d\u300f-]*\\s*$")," ").trimEnd();
  }
  return {display};
});
