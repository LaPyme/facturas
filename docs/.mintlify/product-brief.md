# Product brief

## Description

`facturas` is a Node.js and TypeScript SDK for issuing Argentine electronic invoices, credit notes, and debit notes directly through ARCA's WSFE and WSMTXCA services, and for querying taxpayer data. Its public documentation is only in Argentinian Spanish and uses voseo.

## Primary audience

Developers integrating ARCA electronic invoicing into an Argentine business application. They understand Node.js but may not know ARCA's certificate, service, numbering, or recovery requirements.

## Jobs to be done

1. Enable a CUIT, certificate, ARCA services, and sales point safely.
2. Issue a first test invoice and handle every fiscal outcome correctly.
3. Prevent duplicate vouchers with an application key and durable storage, because ARCA does not accept idempotency keys.
4. Add recovery, credit notes, and production configuration.

## Motivation

The SDK replaces direct SOAP handling and fiscal arithmetic with a typed API while preserving provider evidence. `issue()` is the normal emission path. Direct service methods remain available for requests and numbering that `issue()` does not cover. The SDK connects directly to ARCA without a hosted proxy.

The audience and jobs are inferred from the repository README, CLI flows, examples, and existing documentation. Review them if the product's intended reader changes.
