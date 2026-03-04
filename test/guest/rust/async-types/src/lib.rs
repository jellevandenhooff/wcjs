mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "async-types",
        async: [
            "export:test:async-types/api#get-point",
            "export:test:async-types/api#get-pair",
            "export:test:async-types/api#get-list",
            "export:test:async-types/api#get-maybe",
            "export:test:async-types/api#get-name",
            "export:test:async-types/api#safe-divide",
        ],
    });
    use super::Component;
    export!(Component);
}

use bindings::exports::test::async_types::api::{Guest, Point};

struct Component;

impl Guest for Component {
    async fn get_point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    async fn get_pair(a: u32, b: u32) -> (u32, u32) {
        (a, b)
    }

    async fn get_list() -> Vec<i32> {
        vec![10, 20, 30, 40, 50]
    }

    async fn get_maybe(present: bool) -> Option<u32> {
        if present { Some(42) } else { None }
    }

    async fn get_name() -> String {
        String::from("hello from async")
    }

    async fn safe_divide(a: f64, b: f64) -> Result<f64, String> {
        if b == 0.0 {
            Err("division by zero".to_string())
        } else {
            Ok(a / b)
        }
    }
}
