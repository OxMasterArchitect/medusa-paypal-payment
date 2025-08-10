import {
  AbstractPaymentProvider,
  PaymentActions,
} from "@medusajs/framework/utils";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberRawValue,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import { AbstractEventBusModuleService, MedusaError } from "@medusajs/utils";
import {
  OrdersController,
  PaymentsController,
  CheckoutPaymentIntent,
  ApiError,
  Environment,
  LogLevel,
  Client as PaypalClient,
  Order as PaypalOrder,
  OrderStatus as PaypalOrderStatus,
  PatchOp,
  Money,
} from "@paypal/paypal-server-sdk";
import { convertAmount } from "./formatters";

type Options = {
  oAuthClientId?: string;
  oAuthClientSecret?: string;
  environment?: string;
};

type InjectedDependencies = {
  logger: Logger;
  event_bus: AbstractEventBusModuleService;
};

class PaypalPaymentProviderService extends AbstractPaymentProvider<Options> {
  static identifier = "paypal-payment";

  protected logger_: Logger;
  protected options_: Options;
  protected paypal_: PaypalClient;
  protected eventBusService_: AbstractEventBusModuleService;
  constructor(container: InjectedDependencies, options: Options) {
    super(container, options);

    this.logger_ = container.logger;
    this.options_ = options;
    this.eventBusService_ = container.event_bus;

    if (
      this.options_.oAuthClientId &&
      this.options_.oAuthClientSecret &&
      this.options_.environment
    ) {
      this.paypal_ = new PaypalClient({
        clientCredentialsAuthCredentials: {
          oAuthClientId: this.options_.oAuthClientId,
          oAuthClientSecret: this.options_.oAuthClientSecret,
        },
        timeout: 0,
        environment:
          this.options_.environment === "sandbox"
            ? Environment.Sandbox
            : Environment.Production,
        logging: {
          logLevel: LogLevel.Info,
          logRequest: {
            logBody: true,
          },
          logResponse: {
            logHeaders: true,
          },
        },
      });
    } else {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "oAuthClientId, oAuthClientSecret and environment are required in the provider's options."
      );
    }
  }

  static validateOptions(options: Record<any, any>) {
    if (!options.oAuthClientId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "oAuthClientId is required in the provider's options."
      );
    }
    if (!options.oAuthClientSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "oAuthClientSecret is required in the provider's options."
      );
    }
    if (
      options.environment !== "production" &&
      options.environment !== "sandbox"
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "environment needs to be either production or sandbox"
      );
    }
  }

  async capturePayment(
    paymentData: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const paypalOrder = paymentData.data!.paypalOrder as PaypalOrder;

    if (
      paypalOrder.purchaseUnits?.length &&
      paypalOrder.purchaseUnits[0].payments &&
      paypalOrder.purchaseUnits[0].payments.authorizations?.length
    ) {
      const id = paypalOrder.purchaseUnits[0].payments!.authorizations[0]
        .id as string;
      try {
        const paymentsController = new PaymentsController(this.paypal_);
        await paymentsController.captureAuthorizedPayment({
          authorizationId: id,
        });
        return await this.retrievePayment(paymentData);
      } catch (error) {
        this.logger_.error(error);
        throw new Error("An error occurred in capturePayment");
      }
    }
    throw new Error("An error occurred in capturePayment");
  }

  async authorizePayment(
    paymentData: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    try {
      const status = (await this.getPaymentStatus(paymentData)).status;
      const retrievedPayment = await this.retrievePayment(paymentData);
      return {
        data: {
          ...paymentData,
          paypalOrder: retrievedPayment.data!.paypalOrder,
          paypalOrderId: (retrievedPayment.data!.paypalOrder! as PaypalOrder)
            .id,
        },
        status: status,
      };
    } catch (error) {
      throw new Error("Authorize payment failed");
    }
  }
  async cancelPayment(
    paymentData: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const paypalOrder = paymentData.data!.paypalOrder as PaypalOrder;
    if (
      paypalOrder.purchaseUnits?.length &&
      paypalOrder.purchaseUnits[0].payments
    ) {
      const isAlreadyCanceled = paypalOrder.status === PaypalOrderStatus.Voided;
      const isCanceledAndFullyRefund =
        paypalOrder.status === PaypalOrderStatus.Completed &&
        !!paypalOrder.purchaseUnits[0].invoiceId;
      if (isAlreadyCanceled || isCanceledAndFullyRefund) {
        return await this.retrievePayment(paymentData);
      }
      const paymentsController = new PaymentsController(this.paypal_);
      try {
        const isAlreadyCaptured = paypalOrder.purchaseUnits.some(
          (pu) => pu.payments?.captures?.length
        );
        if (isAlreadyCaptured) {
          const payments = paypalOrder.purchaseUnits[0].payments;
          const capturesId = payments.captures![0].id;
          await paymentsController.refundCapturedPayment({
            captureId: capturesId as string,
          });
        } else {
          const id = paypalOrder.purchaseUnits[0].payments!.authorizations![0]
            .id as string;
          await paymentsController.voidPayment({
            authorizationId: id,
          });
        }
        return await this.retrievePayment(paymentData);
      } catch (error) {
        throw new Error("An error occurred in cancelPayment");
      }
    }
    throw new Error("An error occurred in cancelPayment");
  }
  async initiatePayment(
    paymentData: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const ordersController = new OrdersController(this.paypal_);
    const { currency_code, amount } = paymentData;

    try {
      const { result, ...httpResponse } = await ordersController.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              amount: convertAmount(amount, currency_code) as unknown as Money,
            },
          ],
        },
      });
      if (result.id) {
        return {
          id: result.id,
          data: {
            ...paymentData,
            paypalOrderId: result.id,
            paypalOrder: result,
          },
        };
      }
    } catch (error) {
      if (error instanceof ApiError) {
        const { statusCode, headers } = error;
        this.logger_.error(`Status code ${statusCode.toString()}`);
        this.logger_.error(JSON.stringify(headers));
      }
    }
    throw new Error("Initialize payment failed");
  }
  async deletePayment(
    paymentSessionData: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return paymentSessionData;
  }
  async getPaymentStatus(
    paymentData: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const retrievedPayment = await this.retrievePayment(paymentData);
    const paypalOrder = retrievedPayment.data!.paypalOrder as PaypalOrder;

    switch (paypalOrder.status) {
      case PaypalOrderStatus.Created:
        return {
          status: "pending",
        };
      case PaypalOrderStatus.Saved:
      case PaypalOrderStatus.Approved:
      case PaypalOrderStatus.PayerActionRequired:
        return {
          status: "requires_more",
        };
      case PaypalOrderStatus.Voided:
        return {
          status: "canceled",
        };
      case PaypalOrderStatus.Completed:
        return {
          status: "authorized",
        };
      default:
        return {
          status: "pending",
        };
    }
  }
  async refundPayment(
    paymentData: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const paypalOrder = paymentData.data!.paypalOrder as PaypalOrder;

    if (
      paypalOrder.purchaseUnits?.length &&
      paypalOrder.purchaseUnits[0].payments
    ) {
      const purchaseUnit = paypalOrder.purchaseUnits[0];
      const isAlreadyCaptured = paypalOrder.purchaseUnits.some(
        (pu) => pu.payments?.captures?.length
      );
      if (!isAlreadyCaptured) {
        throw new Error("Cannot refund an uncaptured payment");
      }

      const paymentId = purchaseUnit.payments?.captures![0].id as string;
      const currencyCode = purchaseUnit.amount?.currencyCode as string;
      const amount = paymentData.amount;
      const paymentsController = new PaymentsController(this.paypal_);
      try {
        await paymentsController.refundCapturedPayment({
          captureId: paymentId,
          body: {
            amount: convertAmount(amount, currencyCode) as unknown as Money,
          },
        });
        return await this.retrievePayment(paymentData);
      } catch (error) {
        this.logger_.error(error);
        throw new Error("An error occurred in refundPayment");
      }
    }
    throw new Error("An error occurred in refundPayment");
  }
  async retrievePayment(
    paymentSessionData: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const ordersController = new OrdersController(this.paypal_);
    try {
      const paypalOrderId = (
        paymentSessionData.data!.paypalOrder as PaypalOrder
      ).id as string;
      const { result, ...httpResponse } = await ordersController.getOrder({
        id: paypalOrderId,
      });
      if (result.id) {
        return {
          data: {
            ...paymentSessionData,
            paypalOrderId: result.id,
            paypalOrder: result,
          },
        };
      }
    } catch (error) {
      if (error instanceof ApiError) {
        const { statusCode, headers } = error;
        this.logger_.error(`Status code ${statusCode.toString()}`);
        this.logger_.error(JSON.stringify(headers));
        throw new Error("Initialize payment failed");
      }
    }
    throw new Error("Initialize payment failed.");
  }
  async updatePayment(
    context: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const ordersController = new OrdersController(this.paypal_);
    const { amount, currency_code } = context;
    try {
      const paypalOrderId = (context.data!.paypalOrder as PaypalOrder)
        .id as string;
      await ordersController.patchOrder({
        id: paypalOrderId,
        body: [
          {
            op: PatchOp.Replace,
            value: {
              amount: convertAmount(amount, currency_code) as unknown as Money,
            },
          },
        ],
      });
      return await this.retrievePayment(context);
    } catch (error) {
      this.logger_.error(error);
      throw new Error("An error occurred in updatePayment");
    }
  }
  async getWebhookActionAndData(
    data: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    return {
      action: PaymentActions.NOT_SUPPORTED,
    };
  }
}

export default PaypalPaymentProviderService;
