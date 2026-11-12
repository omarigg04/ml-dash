import { Buyer } from "./Buyer.interface";
import { OrderItem } from "./OrderItem.interface";
import { Payment } from "./Payment.interface";
import { Seller } from "./Seller.interface";

export interface Order {
    listCost: number;
    payments: Payment[];
    fulfilled: boolean;
    taxes: {
      amount: number | null;
      currency_id: string | null;
      id: number | null;
    };
    order_request: {
      change: any; // Podrías especificar la estructura exacta si es conocida
      return: any; // Podrías especificar la estructura exacta si es conocida
    };
    expiration_date: string;
    feedback: {
      buyer: any; // Podrías especificar la estructura exacta si es conocida
      seller: any; // Podrías especificar la estructura exacta si es conocida
    };
    shipping: {
      id: number;
      /** Solo en órdenes abiertas: estado del envío consultado por /api/orders */
      status?: string;
      substatus?: string | null;
      phase?: 'to_ship' | 'in_transit' | 'delivered' | 'cancelled' | null;
    };
    date_closed: string;
    id: number;
    manufacturing_ending_date: string | null;
    order_items: OrderItem[];
    date_last_updated: string;
    last_updated: string;
    comment: string | null;
    pack_id: number | null;
    coupon: {
      amount: number;
      id: number | null;
    };
    shipping_cost: number | null;
    date_created: string;
    pickup_id: any; // Podrías especificar la estructura exacta si es conocida
    status_detail: string | null;
    tags: string[];
    buyer: Buyer[];
    seller: Seller[];
    total_amount: number;
    paid_amount: number;
    currency_id: string;
    status: string;
    context: {
      application: any; // Podrías especificar la estructura exacta si es conocida
      product_id: any; // Podrías especificar la estructura exacta si es conocida
      channel: string;
      site: string;
      flows: any[]; // Podrías especificar la estructura exacta si es conocida
    };
  }