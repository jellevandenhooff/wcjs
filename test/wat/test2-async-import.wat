;; Test 2: Async callback with multiple yields.
;;
;; Tests whether the host correctly handles the callback being called
;; multiple times (YIELD → callback → YIELD → callback → EXIT).
;;
;; Includes context builtins (unused) to work around jco ASYNC_EVENT_CODE bug.

(component
  (type $result-type (result))

  (core module $m
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))

    ;; State: 0 = first callback (yield again), 1+ = done
    (global $state (mut i32) (i32.const 0))

    (func (export "run") (result i32)
      (i32.const 1))        ;; YIELD

    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      (global.get $state)
      (if (result i32) (i32.eqz)
        (then
          ;; First callback: yield again to test multiple yields
          (global.set $state (i32.const 1))
          (i32.const 1))    ;; YIELD
        (else
          ;; Second callback: we're done
          (call $task.return (i32.const 0))  ;; ok
          (i32.const 0))    ;; EXIT
      )
    )
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))

  (core instance $i (instantiate $m (with "" (instance
    (export "task.return" (func $task.return))
    (export "context.get" (func $context.get))
    (export "context.set" (func $context.set))
  ))))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (callback (func $run-cb))))

  (component $shim
    (type $r (result))
    (type $run-func (func async (result $r)))
    (import "import-func-run" (func (type $run-func)))
    (type $r2 (result))
    (type $run-func2 (func async (result $r2)))
    (export "run" (func 0) (func (type $run-func2)))
  )
  (instance $shim-inst (instantiate $shim (with "import-func-run" (func $run))))
  (export "wasi:cli/run@0.3.0-rc-2026-01-06" (instance $shim-inst))
)
