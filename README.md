# Medusa Paypal Payment

## What is it?

Medusa Paypal Payment is a basic integration of payment provider for Paypal.

## Installation

1. Install plugin by adding to your `package.json`:

**Warning**

```json
...
"@nackamoto/medusa-paypal-payment": "0.0.2" // or other available version
...
```

and execute install, e.g. `yarn install`.

2. Add plugin to your `medusa-config.js` (**Note** - please notice that you need to add it to payment plugin):

```js
...
  plugins: [
    {
      resolve: "@nackamoto/medusa-paypal-payment",
      options: {
        oAuthClientId: <oauth-client-id>,
        oAuthClientSecret: <oauth-client-secret>,
        environment: <env-definition>,
      },
    }
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@nackamoto/medusa-paypal-payment/providers/paypal-payment",
            id: "paypal-payment",
            options: {
              oAuthClientId: <oauth-client-id>,
              oAuthClientSecret: <oauth-client-secret>,
              environment: <env-definition>,
            },
          }
        ]
      },
    },
...
```

## Overview

The Paypal Provider gives ability to:

- make a payment using Paypal
- cancel payment
- refund payment
- track payments in Paypal

## Configuration

Plugin uses 3 required parameters:

- `oAuthClientId` - required parameter which you can find in your Paypal Developer Dashboard
- `oAuthClientSecret` - required parameter which you can find in your Paypal Developer Dashboard
- `environment` - set to `sandbox` or `production`. You can use it to test with your `sandbox` environment.

After above configuration, you can then add the payment provider to your reqion.

## Storefront

We recommend using `@paypal/react-paypal-js` package on your storefront as it simplifies the implementation a lot.
Here is the example of using Paypal as payment:

```tsx
import { OnApproveActions, OnApproveData } from "@paypal/paypal-js"
import { PayPalButtons, usePayPalScriptReducer } from "@paypal/react-paypal-js"
...
const PayPalPaymentButton = ({
  cart,
  notReady,
  "data-testid": dataTestId,
}: {
  cart: HttpTypes.StoreCart
  notReady: boolean
  "data-testid"?: string
}) => {
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onPaymentCompleted = async () => {
    await placeOrder()
      .catch((err) => {
        setErrorMessage(err.message)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  const session = cart.payment_collection?.payment_sessions?.find(
    (s) => s.status === "pending"
  )

  const handlePayment = async (
    _data: OnApproveData,
    actions: OnApproveActions
  ) => {
    actions?.order
      ?.authorize()
      .then((authorization) => {
        if (authorization.status !== "COMPLETED") {
          setErrorMessage(`An error occurred, status: ${authorization.status}`)
          return
        }
        onPaymentCompleted()
      })
      .catch((error) => {
        setErrorMessage(`An unknown error occurred, please try again.`)
        setSubmitting(false)
      })
  }

  const [{ isPending, isResolved }] = usePayPalScriptReducer()

  if (isPending) {
    return <Spinner />
  }

  if (isResolved) {
    return (
      <>
        <PayPalButtons
          style={{ layout: "horizontal" }}
          createOrder={async () => {
            return session?.data.paypalOrderId as string;
          }}
          onApprove={handlePayment}
          disabled={notReady || submitting || isPending}
          data-testid={dataTestId}
        />
        <ErrorMessage
          error={errorMessage}
          data-testid="paypal-payment-error-message"
        />
      </>
    )
  }
}
...

// Please remember that above PaypalButton needs to be a child of PaypalScriptProvider

return (<PayPalScriptProvider
    options={{
      "client-id": process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "test",
      currency: cart?.currency_code.toUpperCase(),
      intent: "authorize",
      components: "buttons",
    }}
  >
    {children}
  </PayPalScriptProvider>
)
```

`client-id` - you can retrieve it from your Paypal Developer Dashboard.

### Notes

1. Intent has been chosen to `authorize` in `PayPalScriptProvider` - it means that firstly payment is authorized, then it can be capture via Admin UI. Plugin (not yet) support automatic capturing.
2. `usePayPalScriptReducer` requires `PayPalScriptProvider` to be a parent. It is not problem when making a payment, but when you would like to redirect the user you need be careful. The best option is to put `PayPalScriptProvider` as high as possible in components' tree.
3. `session?.data.paypalOrderId` - `paypalOrderId` is created by the plugin and put it in the `data`. However, there are more information put in `data` by the plugin, so you can log them into console and see how you can use it in your storefront.

## License

MIT

---

© 2025 RSC https://rsoftcon.com/
