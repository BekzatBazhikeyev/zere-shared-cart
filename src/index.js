
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

const modes = new Set(["sale", "receipt", "writeoff", "inventory"]);


const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const empty = () => ({
  version: 0,
  items: [],
  status: "OPEN",
  saleId: null
});

const validQty = (n, zero = false) =>
  Number.isFinite(n) &&
  n >= (zero ? 0 : 0.001) &&
  n <= 100000 &&
  Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

export class SharedCart {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (new URL(request.url).pathname === "/api/favorites") {
      if (request.method === "GET") {
        return json(
          await this.ctx.storage.get("favorites") ||
          { version: 0, ids: [] }
        );
      }

      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      let change;
      try {
        change = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const itemId = String(change.id ?? "");

      if (
        !/^\d{1,16}$/.test(itemId) ||
        typeof change.selected !== "boolean"
      ) {
        return json({ ok: false, error: "Неверные данные" }, 400);
      }

      const updated = await this.ctx.storage.transaction(async txn => {
        const current =
          await txn.get("favorites") || { version: 0, ids: [] };

        const ids = new Set(current.ids);

        if (change.selected) ids.add(itemId);
        else ids.delete(itemId);

        if (ids.size > 1000) {
          return { error: "Слишком много избранных товаров" };
        }

        const next = {
          version: current.version + 1,
          ids: [...ids]
        };

        await txn.put("favorites", next);
        return next;
      });

      return updated.error
        ? json({ ok: false, error: updated.error }, 400)
        : json({ ok: true, ...updated });
    }

    if (request.method === "GET") {
      return json(await this.ctx.storage.get("cart") || empty());
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const mode = request.headers.get("X-Zere-Mode") || "sale";

    if (!modes.has(mode)) {
      return json({ ok: false, error: "Unknown mode" }, 400);
    }

    try {
      const result = await this.ctx.storage.transaction(async txn => {
        const cart = await txn.get("cart") || empty();

        if (
          !Number.isSafeInteger(input.expectedVersion) ||
          input.expectedVersion !== cart.version
        ) {
          return { conflict: true, cart };
        }

        const action = String(input.action || "");

        const begin = {
          sale: "beginSale",
          receipt: "beginReceipt",
          writeoff: "beginWriteoff",
          inventory: "beginInventory"
        }[mode];

        const complete = {
          sale: "completeSale",
          receipt: "completeReceipt",
          writeoff: "completeWriteoff",
          inventory: "completeInventory"
        }[mode];

        const fail = {
          sale: "failSale",
          receipt: "failReceipt",
          writeoff: "failWriteoff",
          inventory: "failInventory"
        }[mode];

        if (action === begin) {
          if (cart.status !== "OPEN" || !cart.items.length) {
            return { error: "Операция недоступна", status: 409 };
          }

          const next = {
            ...cart,
            version: cart.version + 1,
            status: "PROCESSING",
            saleId: crypto.randomUUID(),
            updatedAt: new Date().toISOString()
          };

          await txn.put("cart", next);
          return { ok: true, cart: next };
        }

        if (action === complete || action === fail) {
          if (
            cart.status !== "PROCESSING" ||
            !cart.saleId ||
            input.saleId !== cart.saleId
          ) {
            return { error: "ID операции не совпадает", status: 409 };
          }

          const next = {
            ...cart,
            version: cart.version + 1,
            items: action === complete ? [] : cart.items,
            status: "OPEN",
            saleId: null,
            updatedAt: new Date().toISOString()
          };

          await txn.put("cart", next);
          return { ok: true, cart: next };
        }

        if (cart.status !== "OPEN") {
          return {
            error: "Корзина заблокирована на время проведения",
            status: 409
          };
        }

        const items = cart.items.map(x => ({ ...x }));

        if (action === "add") {
          const p = input.product;
          const id = String(p?.id ?? "");
          const name = String(p?.name ?? "").trim();
          const price = Number(p?.price);
          const qty = Number(p?.quantity ?? 1);

          if (
            !/^\d{1,16}$/.test(id) ||
            !name ||
            name.length > 180 ||
            !Number.isFinite(price) ||
            price < 0 ||
            price > 1e8 ||
            !validQty(qty, mode === "inventory")
          ) {
            return {
              error: "Неверный товар или количество",
              status: 400
            };
          }

          const found = items.find(x => x.id === id);

          if (found) {
            const n = mode === "inventory"
              ? found.quantity
              : Math.round((found.quantity + qty) * 1000) / 1000;

            if (!validQty(n, mode === "inventory")) {
              return { error: "Превышено количество", status: 400 };
            }

            found.quantity = n;
          } else {
            if (items.length >= 100) {
              return { error: "Не более 100 товаров", status: 400 };
            }

            items.push({ id, name, price, quantity: qty });
          }
        } else if (action === "update") {
          const item = items.find(
            x => x.id === String(input.id ?? "")
          );

          if (!item) {
            return { error: "Товар не найден", status: 404 };
          }

          if (input.quantity !== undefined) {
            const n = Number(input.quantity);

            if (!validQty(n, mode === "inventory")) {
              return { error: "Неверное количество", status: 400 };
            }

            item.quantity = n;
          }
        } else if (action === "remove") {
          const i = items.findIndex(
            x => x.id === String(input.id ?? "")
          );

          if (i < 0) {
            return { error: "Товар не найден", status: 404 };
          }

          items.splice(i, 1);
        } else if (action === "clear") {
          items.length = 0;
        } else {
          return { error: "Неизвестное действие", status: 400 };
        }

        const next = {
          ...cart,
          version: cart.version + 1,
          items,
          updatedAt: new Date().toISOString()
        };

        await txn.put("cart", next);
        return { ok: true, cart: next };
      });

      if (result.conflict) {
        return json({
          ok: false,
          conflict: true,
          cart: result.cart
        }, 409);
      }

      if (result.error) {
        return json({
          ok: false,
          error: result.error
        }, result.status || 400);
      }

      return json(result);
    } catch {
      return json({
        ok: false,
        error: "Ошибка сохранения корзины"
      }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    const path = new URL(request.url).pathname;

    if (path === "/health") {
      return json({
        ok: true,
        service: "zere-shared-cart",
        version: 6
      });
    }

    if (path === "/api/favorites") {
      const id = env.SHARED_CART.idFromName(
        "zere:global:favorites:v1"
      );

      return env.SHARED_CART.get(id).fetch(request);
    }

    let mode;
    let session;

    if (
      path === "/api/session" &&
      request.method === "POST"
    ) {
      mode = "sale";
    } else if (
      path === "/api/receiving/session" &&
      request.method === "POST"
    ) {
      mode = "receipt";
    } else {
      const m = path.match(
        /^\/api\/(sale|receipt|writeoff|inventory)\/session(?:\/([0-9a-f-]{36}))?$/i
      );

      if (m) {
        mode = m[1].toLowerCase();
        session = m[2];
      } else {
        const old = path.match(
          /^\/api\/(receiving\/)?session\/([0-9a-f-]{36})$/i
        );

        if (old) {
          mode = old[1] ? "receipt" : "sale";
          session = old[2];
        }
      }
    }

    if (!mode || !modes.has(mode)) {
      return json({ ok: false, error: "Маршрут не найден" }, 404);
    }

    if (!session) {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      return json({
        ok: true,
        sessionId: crypto.randomUUID()
      });
    }

    if (!uuid.test(session)) {
      return json({ ok: false, error: "Неверный код сессии" }, 400);
    }

    if (!["GET", "POST"].includes(request.method)) {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const id = env.SHARED_CART.idFromName(
      mode === "sale" ? session : mode + ":" + session
    );

    const stub = env.SHARED_CART.get(id);

    const proxied = new Request(request, {
      headers: new Headers(request.headers)
    });

    proxied.headers.set("X-Zere-Mode", mode);

    return stub.fetch(proxied);
  }
};
