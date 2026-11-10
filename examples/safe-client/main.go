// safe-client is the corrected integration: one PayPal-Request-Id (a UUID) per
// logical step, reused on every retry of that step; exponential backoff with
// jitter; a fresh token after a 401; and a GET of the order when PayPal says it
// was already captured.
package main

import (
	"flag"
	"fmt"
	mrand "math/rand/v2"
	"time"

	"github.com/shangai2405/paychaos/examples/internal/pp"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:8080", "API base URL (point at paychaos)")
	n := flag.Int("n", 20, "number of checkouts to simulate")
	flag.Parse()

	c := pp.New(*base, "demo-client", "demo-secret")
	if err := c.Refresh(); err != nil {
		fmt.Println("safe-client:", err)
		return
	}
	paid, refunded := 0, 0
	for i := 0; i < *n; i++ {
		inv := fmt.Sprintf("INV-%03d", i)
		// In a real app these ids are stored with the order, so a crashed
		// and restarted job reuses them too.
		createID, captureID, refundID := pp.UUID(), pp.UUID(), pp.UUID()

		order := retry(c, func() pp.Response { return c.Do("POST", "/v2/checkout/orders", createID, pp.OrderBody(inv, 1000+i)) })
		if !order.OK() {
			continue
		}
		id, _ := order.Body["id"].(string)
		capture := retry(c, func() pp.Response { return c.Do("POST", "/v2/checkout/orders/"+id+"/capture", captureID, nil) })
		if capture.Status == 422 && capture.Issue() == "ORDER_ALREADY_CAPTURED" {
			// PayPal's advice: read the capture from the order.
			capture = retry(c, func() pp.Response { return c.Do("GET", "/v2/checkout/orders/"+id, "", nil) })
		}
		if !capture.OK() {
			continue
		}
		paid++
		if i%3 == 0 {
			capID := pp.CaptureID(capture.Body)
			if r := retry(c, func() pp.Response {
				return c.Do("POST", "/v2/payments/captures/"+capID+"/refund", refundID, pp.RefundBody(inv+"-R", 300))
			}); r.OK() {
				refunded++
			}
		}
	}
	fmt.Printf("safe-client: %d/%d checkouts reported paid, %d refunds reported\n", paid, *n, refunded)
}

func retry(c *pp.Client, f func() pp.Response) pp.Response {
	backoff := 250 * time.Millisecond
	var r pp.Response
	for attempt := 0; attempt < 6; attempt++ {
		if r = f(); r.OK() || !r.Retryable() {
			return r
		}
		if r.Status == 401 {
			_ = c.Refresh()
			continue
		}
		time.Sleep(backoff + time.Duration(mrand.Int64N(int64(backoff/2))))
		backoff *= 2
	}
	return r
}
