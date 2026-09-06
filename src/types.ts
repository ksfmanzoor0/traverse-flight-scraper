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
  fareTotal: number;           // adult gross_fare (PKR, integer) — from pax_type_fare_breakdown.adult.gross_fare
  baseFare: number;            // adult base_fare
  tax: number;                 // adult tax
  childFareTotal: number | null;   // child gross_fare from pax_type_fare_breakdown; null if carrier doesn't quote children
  infantFareTotal: number | null;  // infant gross_fare from pax_type_fare_breakdown; null if carrier doesn't quote infants
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
