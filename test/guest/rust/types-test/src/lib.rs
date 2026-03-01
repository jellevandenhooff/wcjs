#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "types-test",
        async: [
            "import:test:types/host-fns#async-double",
            "export:test:types/api#double-sum",
        ],
    });
    use super::Component;
    export!(Component);
}

use bindings::exports::test::types::api::{self as api_types, Guest};
use bindings::test::types::host_fns;

struct Component;

impl Guest for Component {
    fn greet(name: String) -> String {
        host_fns::echo_string(&format!("Hello, {}!", name))
    }

    fn compute_distance(a: api_types::Point, b: api_types::Point) -> f64 {
        // Also test record import round-trip via scale_point
        let scaled = host_fns::scale_point(
            host_fns::Point { x: a.x, y: a.y },
            1.0,
        );
        host_fns::log(&format!("scaled: ({}, {})", scaled.x, scaled.y));

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        (dx * dx + dy * dy).sqrt()
    }

    fn color_to_number(c: api_types::Color) -> u32 {
        match c {
            api_types::Color::Red => 0xFF0000,
            api_types::Color::Green => 0x00FF00,
            api_types::Color::Blue => 0x0000FF,
        }
    }

    fn describe_person(p: api_types::Person) -> String {
        format!("{} is {} years old", p.name, p.age)
    }

    fn reverse_list(nums: Vec<i32>) -> Vec<i32> {
        // Test list import: compute sum via host
        let sum = host_fns::sum_list(&nums);
        host_fns::log(&format!("sum before reverse: {}", sum));

        let mut result = nums;
        result.reverse();
        result
    }

    fn safe_divide(a: f64, b: f64) -> Result<f64, String> {
        if b == 0.0 {
            Err("division by zero".to_string())
        } else {
            Ok(a / b)
        }
    }

    async fn double_sum(a: u32, b: u32) -> u32 {
        let da = host_fns::async_double(a).await;
        let db = host_fns::async_double(b).await;
        let total = host_fns::add_integers(da as i32, db as i32);
        total as u32
    }
}
