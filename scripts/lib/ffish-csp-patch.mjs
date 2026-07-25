// CSP patch for ffish-es6's emscripten/embind glue (node_modules/ffish-es6/ffish.js).
//
// WHY: the packaged app runs under the strict PROD_CSP (src/main/security.ts,
// script-src 'self' 'wasm-unsafe-eval'). 'wasm-unsafe-eval' unblocks
// WebAssembly compilation, but ffish-es6 0.7.9 was built with an old emscripten
// whose embind glue ALSO does string-eval at runtime (new Function) in three
// places, which only full 'unsafe-eval' would allow. Rather than widening the
// CSP for the whole renderer, we rewrite those three functions to the
// eval-free equivalents emscripten itself emits under -s DYNAMIC_EXECUTION=0:
//
//   1. createNamedFunction: used `new Function` purely to give wrappers a
//      nice .name; replaced by Object.defineProperty(fn, 'name', ...).
//   2. makeDynCaller (inside embind__requireFunction): crafted a fixed-arity
//      forwarder source string; replaced by a generic apply() forwarder.
//   3. craftInvokerFunction: crafted each bound method's invoker as a source
//      string; replaced by a generic closure with identical semantics
//      (arg-count check, toWireType marshalling with a destructor stack or
//      per-arg destructorFunction calls, fromWireType on return).
//
// The patch is applied IN PLACE to node_modules by scripts/patch-ffish-csp.mjs
// (npm postinstall), so the Vite renderer bundle, electron-vite dev, and every
// headless esbuild test suite all consume the same eval-free glue.
//
// Exact-match contract: each `find` below must appear exactly once in the
// pristine ffish.js. If ffish-es6 is ever upgraded and the glue changes, the
// patcher THROWS instead of shipping a packaged app that dies under CSP again.
// Re-derive the patches (or drop them if upstream ships DYNAMIC_EXECUTION=0)
// and re-verify with scripts/smoke-packed-wasm.mjs.

/** Marker comment prepended to the patched file, used for idempotence. */
export const PATCH_MARKER = '/* ffish-csp-patch: eval-free embind glue (see scripts/lib/ffish-csp-patch.mjs) */'

export const FFISH_CSP_PATCHES = [
  {
    name: 'createNamedFunction',
    find:
      'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)}',
    replace:
      'function createNamedFunction(name,body){name=makeLegalFunctionName(name);try{Object.defineProperty(body,"name",{value:name})}catch(e){}return body}'
  },
  {
    name: 'makeDynCaller',
    find:
      'function makeDynCaller(dynCall){var args=[];for(var i=1;i<signature.length;++i){args.push("a"+i)}var name="dynCall_"+signature+"_"+rawFunction;var body="return function "+name+"("+args.join(", ")+") {\\n";body+="    return dynCall(rawFunction"+(args.length?", ":"")+args.join(", ")+");\\n";body+="};\\n";return new Function("dynCall","rawFunction",body)(dynCall,rawFunction)}',
    replace:
      'function makeDynCaller(dynCall){return function(){var args=[rawFunction];for(var i=0;i<arguments.length;i++){args.push(arguments[i])}return dynCall.apply(null,args)}}'
  },
  {
    name: 'craftInvokerFunction',
    find:
      'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var argsList="";var argsListWired="";for(var i=0;i<argCount-2;++i){argsList+=(i!==0?", ":"")+"arg"+i;argsListWired+=(i!==0?", ":"")+"arg"+i+"Wired"}var invokerFnBody="return function "+makeLegalFunctionName(humanName)+"("+argsList+") {\\n"+"if (arguments.length !== "+(argCount-2)+") {\\n"+"throwBindingError(\'function "+humanName+" called with \' + arguments.length + \' arguments, expected "+(argCount-2)+" args!\');\\n"+"}\\n";if(needsDestructorStack){invokerFnBody+="var destructors = [];\\n"}var dtorStack=needsDestructorStack?"destructors":"null";var args1=["throwBindingError","invoker","fn","runDestructors","retType","classParam"];var args2=[throwBindingError,cppInvokerFunc,cppTargetFunc,runDestructors,argTypes[0],argTypes[1]];if(isClassMethodFunc){invokerFnBody+="var thisWired = classParam.toWireType("+dtorStack+", this);\\n"}for(var i=0;i<argCount-2;++i){invokerFnBody+="var arg"+i+"Wired = argType"+i+".toWireType("+dtorStack+", arg"+i+"); // "+argTypes[i+2].name+"\\n";args1.push("argType"+i);args2.push(argTypes[i+2])}if(isClassMethodFunc){argsListWired="thisWired"+(argsListWired.length>0?", ":"")+argsListWired}invokerFnBody+=(returns?"var rv = ":"")+"invoker(fn"+(argsListWired.length>0?", ":"")+argsListWired+");\\n";if(needsDestructorStack){invokerFnBody+="runDestructors(destructors);\\n"}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var paramName=i===1?"thisWired":"arg"+(i-2)+"Wired";if(argTypes[i].destructorFunction!==null){invokerFnBody+=paramName+"_dtor("+paramName+"); // "+argTypes[i].name+"\\n";args1.push(paramName+"_dtor");args2.push(argTypes[i].destructorFunction)}}}if(returns){invokerFnBody+="var ret = retType.fromWireType(rv);\\n"+"return ret;\\n"}else{}invokerFnBody+="}\\n";args1.push(invokerFnBody);var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}',
    replace:
      'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expectedArgCount=argCount-2;return function(){if(arguments.length!==expectedArgCount){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expectedArgCount+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;var invokerArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerArgs.push(thisWired)}var argsWired=new Array(expectedArgCount);for(var i=0;i<expectedArgCount;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);invokerArgs.push(argsWired[i])}var rv=cppInvokerFunc.apply(null,invokerArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var param=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}}}'
  }
]

/**
 * Apply the patches to pristine ffish.js source.
 * @param {string} source pristine node_modules/ffish-es6/ffish.js contents
 * @returns {string} patched source (marker + rewritten glue)
 * @throws if the source is already patched, if any find-string is missing or
 *         ambiguous, or if any dynamic-execution site survives the rewrite.
 */
export function patchFfishSource(source) {
  if (source.startsWith(PATCH_MARKER)) {
    throw new Error('ffish-csp-patch: source is already patched')
  }
  let out = source
  for (const { name, find, replace } of FFISH_CSP_PATCHES) {
    const first = out.indexOf(find)
    if (first === -1) {
      throw new Error(
        `ffish-csp-patch: site "${name}" not found: ffish-es6 changed (upgrade?). ` +
          'Re-derive scripts/lib/ffish-csp-patch.mjs and re-verify with scripts/smoke-packed-wasm.mjs.'
      )
    }
    if (out.indexOf(find, first + 1) !== -1) {
      throw new Error(`ffish-csp-patch: site "${name}" matched more than once: refusing to patch`)
    }
    out = out.slice(0, first) + replace + out.slice(first + find.length)
  }
  // Belt and braces: no dynamic-execution construct may survive. (`eval(` was
  // never present in this build; `new Function`/`new_(Function` must be gone.)
  for (const banned of ['new Function', 'new_(Function']) {
    if (out.includes(banned)) {
      throw new Error(`ffish-csp-patch: "${banned}" still present after patching: patch table is stale`)
    }
  }
  return PATCH_MARKER + '\n' + out
}

/** @param {string} source @returns {boolean} true if `source` already carries the patch. */
export function isFfishSourcePatched(source) {
  return source.startsWith(PATCH_MARKER)
}
