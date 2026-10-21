import { ShoppingActions } from './shoppingActions';
import { ShoppingWorkflows } from './shoppingWorkflows';
import { FeedbackStore } from './feedbackStore';
import { ReorderStore } from './reorder';
import { ComparisonStore } from './comparison';
import { ReviewsStore } from './reviews';
import { SupportStore } from './support';
import { AssistantLibrary } from './assistantLibrary';
import type { OperationKind } from './operations';
import { NavigationStore } from './navigationStore';
import { OrderStore } from './orderStore';
import { WishlistStore } from './wishlistStore';
import { NotificationsStore } from './notificationsStore';
import { CatalogStore } from './catalogStore';
import { AssistantStore } from './assistantStore';
import type { CommerceClient, Storage } from './commerce';
import { AccountStore } from './account';
import { CartStore } from './cart';
import { CheckoutFlow } from './checkout';
import { DeliveryForm } from './delivery';
import { OperationCoordinator } from './operations';
import { OperationCancelled } from './featureState';

export class ShoppingSession {
  readonly actions: ShoppingActions;
  readonly catalog: CatalogStore;
  readonly assistant: AssistantStore;
  readonly checkout: CheckoutFlow;
  readonly feedback = new FeedbackStore();
  readonly operations = new OperationCoordinator();
  readonly delivery: DeliveryForm;
  readonly navigation = new NavigationStore();
  readonly orders: OrderStore;
  readonly account: AccountStore;
  readonly cart: CartStore;
  readonly reorder: ReorderStore;
  readonly comparison = new ComparisonStore();
  readonly reviews: ReviewsStore;
  readonly support: SupportStore;
  readonly library: AssistantLibrary;
  readonly wishlist: WishlistStore;
  readonly notifications: NotificationsStore;
  onIdentityChange?: () => void;
  private generation = 0;
  constructor(private client: CommerceClient, notificationPreferences?: Storage) {
    this.actions = new ShoppingActions(client, this, () => this.generation);
    this.wishlist = new WishlistStore(client);
    this.notifications = new NotificationsStore(client, notificationPreferences);
    this.catalog = new CatalogStore(client);
    this.assistant = new AssistantStore(client);
    this.checkout = new CheckoutFlow(client);
    this.delivery = new DeliveryForm(client, this.checkout);
    this.orders = new OrderStore(client);
    let previousPanel = this.navigation.getSnapshot().panel;
    this.navigation.subscribe(() => {
      const panel = this.navigation.getSnapshot().panel;
      const leavingOrder = previousPanel === 'order' && panel !== previousPanel;
      previousPanel = panel;
      if (leavingOrder && this.orders.getSnapshot().selectedID) this.orders.show(null);
    });
    this.account = new AccountStore(client);
    this.cart = new CartStore(client, this.checkout);
    this.reorder = new ReorderStore(client, this.checkout, cart => this.cart.accept(cart));
    this.reviews = new ReviewsStore(client);
    this.support = new SupportStore(client, () => client.newRequestID());
    this.library = new AssistantLibrary(client);
    this.account.onIdentityChange = () => {
      this.generation++;
      this.reorder.reset();
      this.comparison.reset(); this.reviews.reset(); this.support.reset(); this.library.reset();
      this.feedback.clear(); this.orders.reset(); this.navigation.resetCustomerRoutes(); this.operations.invalidatePending(); this.assistant.reset(); this.catalog.dismissProduct(); this.checkout.reset(); this.delivery.reset(); this.cart.reset(); this.wishlist.reset(); this.notifications.reset(); this.onIdentityChange?.();
    };
  }
  perform(operation: () => Promise<void>, kind: OperationKind = 'mutation', locale = this.client.locale) {
    return this.feedback.perform(this.operations, operation, { kind, locale, onUnauthorized: () => { if (!this.client.customer) this.account.reset(); } });
  }
  private async restoreCheckout() {
    const revision = this.generation;
    this.checkout.invalidate();
    const pending = await this.client.pending();
    if (revision !== this.generation) throw new OperationCancelled();
    this.checkout.restore(pending?.quote ?? null);

  }
  readonly workflows = new ShoppingWorkflows({
    restoreAccount: async () => { await this.account.restore(); return !!this.account.getSnapshot().customer; },
    recoverySteps: [() => this.restoreCheckout(), () => this.delivery.refresh(), async () => { await this.cart.refresh(); }, async () => { await this.orders.refresh(); }],
    revision: () => this.generation,
    saveItem: id => this.cart.saveForLater(id),
    refreshWishlist: () => this.wishlist.refreshIDs(),
  });
  reload() { return this.workflows.reload(); }
  dispose() { this.account.reset(); this.catalog.reset(); }
}
