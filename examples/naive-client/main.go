// naive-client is a deliberately buggy PayPal integration: no PayPal-Request-Id,
// instant retries, a 422 treated as a plain failure, and the same access token
// reused after a 401. Run it through paychaos to see what that costs.
package main

import (
	"flag"
	"fmt"

	"github.com/shangai2405/paychaos/examples/internal/pp"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:8080", "API base URL (point at paychaos)")
	n := flag.Int("n", 20, "number of checkouts to simulate")
	flag.Parse()

	c := pp.New(*base, "demo-client", "demo-secret")
	if err := c.Refresh(); err != nil {
		fmt.Println("naive-client:", err)
		return
	}
	paid, refunded := 0, 0
	for i := 0; i < *n; i++ {
		inv := fmt.Sprintf("INV-%03d", i)
		order := retry(func() pp.Response { return c.Do("POST", "/v2/checkout/orders", "", pp.OrderBody(inv, 1000+i)) })
		if !order.OK() {
			continue
		}
		id, _ := order.Body["id"].(string)
		capture := retry(func() pp.Response { return c.Do("POST", "/v2/checkout/orders/"+id+"/capture", "", nil) })
		if !capture.OK() {
			continue // BUG: a 422 ORDER_ALREADY_CAPTURED means it *was* paid
		}
		paid++
		if i%3 == 0 {
			capID := pp.CaptureID(capture.Body)
			r := retry(func() pp.Response {
				return c.Do("POST", "/v2/payments/captures/"+capID+"/refund", "", pp.RefundBody(inv+"-R", 300))
			})
			if r.OK() {
				refunded++
			}
		}
	}
	fmt.Printf("naive-client: %d/%d checkouts reported paid, %d refunds reported\n", paid, *n, refunded)
}

// retry tries up to three times with no backoff and never refreshes the token.
func retry(f func() pp.Response) pp.Response {
	var r pp.Response
	for attempt := 0; attempt < 3; attempt++ {
		if r = f(); r.OK() || !r.Retryable() {
			return r
		}
	}
	return r
}
