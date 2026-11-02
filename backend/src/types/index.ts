export interface TokenData {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
  created_at: number; // Timestamp when token was created
}

export interface MLOrder {
  id: number;
  date_created: string;
  date_closed: string;
  last_updated: string;
  fulfilled: boolean;
  total_amount: number;
  currency_id: string;
  buyer: {
    id: number;
    nickname: string;
    email?: string;
  };
  seller: {
    id: number;
    nickname: string;
  };
  order_items: Array<{
    item: {
      id: string;
      title: string;
      category_id: string;
      variation_id?: number;
    };
    quantity: number;
    unit_price: number;
    full_unit_price: number;
    sale_fee: number;
  }>;
  payments: Array<{
    id: number;
    order_id: number;
    payer_id: number;
    collector: {
      id: number;
    };
    currency_id: string;
    status: string;
    transaction_amount: number;
  }>;
  shipping: {
    id: number;
  };
  status: string;
}

// GET /shipments/:id/costs — qué paga cada parte del envío
export interface MLShipmentCosts {
  receiver?: { user_id: number; cost: number };
  senders?: { user_id: number; cost: number }[];
}

export interface MLShipment {
  id: number;
  order_id: number;
  order_cost: number;
  list_cost?: number;
  shipping_option?: { list_cost?: number; cost?: number };
  cost_components: {
    special_discount?: number;
    loyal_discount?: number;
  };
  status: string;
}
