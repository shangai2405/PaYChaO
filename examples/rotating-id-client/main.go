// rotating-id-client sends PayPal-Request-Id, but builds a new one on every
// attempt from the clock. It looks idempotent and is not: each retry is a new
// operation to PayPal. It does refresh its token on a 401.
package main

import (
	"flag"
	"fmt"
	"time"

	"github.com/shangai2405/paychaos/examples/internal/pp"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:8080", "API base URL (point at paychaos)")
	n := flag.Int("n", 20, "number of checkouts to simulate")
	flag.Parse()

	c := pp.New(*base, "demo-client", "demo-secret")
	if err := c.Refresh(); err != nil {
		fmt.Println("rotating-id-client:", err)
		return
	}
	paid, refunded := 0, 0
	for i := 0; i < *n; i++ {
		inv := fmt.Sprintf("INV-%03d", i)
		order := retry(c, func(rid string) pp.Response {
			return c.Do("POST", "/v2/checkout/orders", rid, pp.OrderBody(inv, 1000+i))
		})
		if !order.OK() {
			continue
		}
		id, _ := order.Body["id"].(string)
		capture := retry(c, func(rid string) pp.Response { return c.Do("POST", "/v2/checkout/orders/"+id+"/capture", rid, nil) })
		if !capture.OK() {
			continue
		}
		paid++
		if i%3 == 0 {
			capID := pp.CaptureID(capture.Body)
			if r := retry(c, func(rid string) pp.Response {
				return c.Do("POST", "/v2/payments/captures/"+capID+"/refund", rid, pp.RefundBody(inv+"-R", 300))
			}); r.OK() {
				refunded++
			}
		}
	}
	fmt.Printf("rotating-id-client: %d/%d checkouts reported paid, %d refunds reported\n", paid, *n, refunded)
}

func retry(c *pp.Client, f func(requestID string) pp.Response) pp.Response {
	var r pp.Response
	for attempt := 0; attempt < 3; attempt++ {
		// BUG: a fresh id per attempt, so a retry is never recognised.
		rid := fmt.Sprintf("req-%d", time.Now().UnixNano())
		if r = f(rid); r.OK() || !r.Retryable() {
			return r
		}
		if r.Status == 401 {
			_ = c.Refresh()
		}
		time.Sleep(250 * time.Millisecond)
	}
	return r
}
