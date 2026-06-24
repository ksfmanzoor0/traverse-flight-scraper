import type { AirportCode, Airline } from "./config.js";

export type RouteType = "ONEWAY" | "RETURN";

export interface FareRow {
  origin: AirportCode;
  destination: AirportCode;
  airline: Airline;
  flightNumbers: string[];     // e.g. ["PK-451"]
  routeType: RouteType;
  departDate: string;          // YYYY-MM-DD
  returnDate: string | null;   // YYYY-MM-DD for RETURN, null for ONEWAY
  fareTotal: number;           // total_amount_after_pricing (PKR, integer)
  baseFare: number;            // base_fare
  tax: number;                 // tax
  rbd: string | null;          // e.g. "ECO LIGHT - I"
  isRefundable: boolean;
  currency: "PKR";
  source: string;              // 'aeroglobe'
  sourceUrl: string;
  scrapedAt: string;           // ISO timestamp
}

export interface ScrapeError {
  source: string;
  origin: AirportCode;
  destination: AirportCode;
  departDate: string;
  returnDate: string | null;
  reason: string;
  scrapedAt: string;
}
