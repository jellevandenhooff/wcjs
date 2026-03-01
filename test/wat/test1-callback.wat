;; Test 1: Minimal async callback — no streams, no imports.
;;
;; Tests whether the host (wasmtime / jco) correctly drives the callback loop
;; for the simplest possible async export.
;;
;; The entry function returns YIELD (1), the callback calls task.return and
;; returns EXIT (0). The exported function signature is: run() -> result
;; matching wasi:cli/run@0.3.0-rc-2026-01-06#run.
;;
;; NOTE: Includes context.get/context.set builtins (unused) to work around a
;; jco bug where ASYNC_EVENT_CODE is only emitted when ContextGet/ContextSet
;; trampolines are present. Without them, AsyncTask.yieldUntil() references
;; an undefined ASYNC_EVENT_CODE constant.

(component
  ;; result type for task.return: result (ok: unit, err: unit)
  (type $result-type (result))

  (core module $m
    (import "" "task.return" (func $task.return (param i32)))
    ;; Context builtins (unused, but required for jco codegen — see NOTE above)
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))

    (func (export "run") (result i32)
      (i32.const 1))        ;; YIELD

    (func (export "run-cb") (param i32 i32 i32) (result i32)
      ;; Return ok (discriminant 0)
      (call $task.return (i32.const 0))
      (i32.const 0))        ;; EXIT
  )

  ;; task.return with result type — flattened to (param i32) for result<_, _>
  (canon task.return (result $result-type) (core func $task.return))
  ;; Context builtins (workaround for jco)
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))

  (core instance $i (instantiate $m (with "" (instance
    (export "task.return" (func $task.return))
    (export "context.get" (func $context.get))
    (export "context.set" (func $context.set))
  ))))

  ;; Lift the async export with callback
  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (callback (func $run-cb))))

  ;; Export as wasi:cli/run interface
  (component $shim
    (type $r (result))
    (type $run-func (func async (result $r)))
    (import "import-func-run" (func (type $run-func)))
    (type $r2 (result))
    (type $run-func2 (func async (result $r2)))
    (export (;1;) "run" (func 0) (func (type $run-func2)))
  )
  (instance $shim-inst (instantiate $shim (with "import-func-run" (func $run))))
  (export "wasi:cli/run@0.3.0-rc-2026-01-06" (instance $shim-inst))
)
