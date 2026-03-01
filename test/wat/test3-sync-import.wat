;; Test 3: Sync host import from async context.
;;
;; The component imports a simple function `get-number` from the host,
;; calls it synchronously via `canon lower`, verifies the result,
;; and returns ok.

(component
  (type $result-type (result))

  ;; Import a simple function from the host
  (type $get-number-type (func (result u32)))
  (import "get-number" (func $get-number (type $get-number-type)))

  ;; Lower the import for core use (sync — no async flag)
  (core func $lowered-get-number (canon lower (func $get-number)))

  (core module $m
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))
    (import "" "get-number" (func $get-number (result i32)))

    (func (export "run") (result i32)
      ;; Call get-number(), expect 42
      (call $get-number)
      (i32.const 42)
      (i32.ne)
      (if (then (unreachable)))  ;; trap if result != 42
      (call $task.return (i32.const 0))  ;; ok
      (i32.const 0))  ;; EXIT

    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      (unreachable))
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))

  (core instance $i (instantiate $m (with "" (instance
    (export "task.return" (func $task.return))
    (export "context.get" (func $context.get))
    (export "context.set" (func $context.set))
    (export "get-number" (func $lowered-get-number))
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
