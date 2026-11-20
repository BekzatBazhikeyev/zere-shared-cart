
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });

const emptyCart = () => ({
  version: 0,
  items: [],
  status: "OPEN"
});

export class SharedCart {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method === "GET") {
      const cart =
        (await this.ctx.storage.get("cart")) || emptyCart();

      return json(cart);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let input;

    try {
      input = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    try {
      const result = await this.ctx.storage.transaction(
        async txn => {
          const cart =
            (await txn.get("cart")) || emptyCart();

          const action = input.action;

          // Повторное подтверждение уже проведённого чека
          if (
            action === "completeSale" &&
            cart.lastSale?.token === input.saleToken
          ) {
            return {
              ok: true,
              alreadyCompleted: true,
              cart
            };
          }

          // Начало проведения продажи
          if (action === "beginSale") {
            if (cart.status !== "OPEN") {
              return {
                error: "Чек уже проводится",
                status: 409,
                cart
              };
            }

            if (!cart.items.length) {
              return {
                error: "Корзина пуста",
                status: 400
              };
            }

            if (
              !Number.isSafeInteger(input.expectedVersion) ||
              input.expectedVersion !== cart.version
            ) {
              return {
                conflict: true,
                cart
              };
            }

            const saleToken = crypto.randomUUID();

            const updated = {
              ...cart,
              version: cart.version + 1,
              status: "PROCESSING",
              saleToken,
              saleStartedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

            await txn.put("cart", updated);

            return {
              ok: true,
              saleToken,
              cart: updated
            };
          }

          // Подтверждение успешной продажи
          if (action === "completeSale") {
            if (
              cart.status !== "PROCESSING" ||
              !input.saleToken ||
              input.saleToken !== cart.saleToken
            ) {
              return {
                error: "Нет соответствующей продажи",
                status: 409,
                cart
              };
            }

            const updated = {
              version: cart.version + 1,
              items: [],
              status: "OPEN",
              lastSale: {
                token: cart.saleToken,
                completedAt: new Date().toISOString()
              },
              updatedAt: new Date().toISOString()
            };

            await txn.put("cart", updated);

            return { ok: true, cart: updated };
          }

          // Отмена блокировки после ошибки продажи
          if (action === "failSale") {
            if (
              cart.status !== "PROCESSING" ||
              !input.saleToken ||
              input.saleToken !== cart.saleToken
            ) {
              return {
                error: "Нет соответствующей продажи",
                status: 409,
                cart
              };
            }

            const updated = {
              ...cart,
              version: cart.version + 1,
              status: "OPEN",
              saleToken: null,
              saleStartedAt: null,
              updatedAt: new Date().toISOString()
            };

            await txn.put("cart", updated);

            return { ok: true, cart: updated };
          }

          // Запрет изменений во время продажи
          if (cart.status !== "OPEN") {
            return {
              error: "Чек проводится. Изменения запрещены",
              status: 409,
              cart
            };
          }

          // Контроль версии корзины
          if (
            !Number.isSafeInteger(input.expectedVersion) ||
            input.expectedVersion !== cart.version
          ) {
            return { conflict: true, cart };
          }

          const items = cart.items.map(item => ({ ...item }));

          if (action === "add") {
            const product = input.product;
            const id = String(product?.id || "");
            const name = String(product?.name || "").trim();
            const price = Number(product?.price);
            const quantity = Number(product?.quantity ?? 1);

            if (
              !/^\d{1,16}$/.test(id) ||
              !name ||
              name.length > 180 ||
              !Number.isFinite(price) ||
              price < 0 ||
              price > 100000000 ||
              !Number.isFinite(quantity) ||
              quantity <= 0 ||
              quantity > 100000
            ) {
              return {
                error: "Неверный товар",
                status: 400
              };
            }

            const existing = items.find(item => item.id === id);

            if (existing) {
              existing.quantity += quantity;

              if (existing.quantity > 100000) {
                return {
                  error: "Превышено количество",
                  status: 400
                };
              }
            } else {
              if (items.length >= 100) {
                return {
                  error: "Корзина переполнена",
                  status: 400
                };
              }

              items.push({ id, name, price, quantity });
            }

          } else if (action === "update") {
            const id = String(input.id || "");
            const item = items.find(item => item.id === id);

            if (!item) {
              return {
                error: "Товар не найден",
                status: 404
              };
            }

            if (input.quantity !== undefined) {
              const quantity = Number(input.quantity);

              if (
                !Number.isFinite(quantity) ||
                quantity <= 0 ||
                quantity > 100000
              ) {
                return {
                  error: "Неверное количество",
                  status: 400
                };
              }

              item.quantity = quantity;
            }

            if (input.price !== undefined) {
              const price = Number(input.price);

              if (
                !Number.isFinite(price) ||
                price < 0 ||
                price > 100000000
              ) {
                return {
                  error: "Неверная цена",
                  status: 400
                };
              }

              item.price = price;
            }

          } else if (action === "remove") {
            const id = String(input.id || "");
            const index = items.findIndex(item => item.id === id);

            if (index === -1) {
              return {
                error: "Товар не найден",
                status: 404
              };
            }

            items.splice(index, 1);

          } else if (action === "clear") {
            items.length = 0;

          } else {
            return {
              error: "Неизвестное действие",
              status: 400
            };
          }

          const updated = {
            ...cart,
            version: cart.version + 1,
            items,
            status: "OPEN",
            updatedAt: new Date().toISOString()
          };

          await txn.put("cart", updated);

          return { ok: true, cart: updated };
        }
      );

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
          error: result.error,
          cart: result.cart
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

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "zere-shared-cart"
      });
    }

    if (
      url.pathname === "/api/session" &&
      request.method === "POST"
    ) {
      return json({
        ok: true,
        sessionId: crypto.randomUUID()
      });
    }

    const match = url.pathname.match(
      /^\/api\/session\/([0-9a-f-]{36})$/
    );

    if (!match) {
      return json({
        error: "Маршрут не найден"
      }, 404);
    }

    const sessionId = match[1];
    const id = env.SHARED_CART.idFromName(sessionId);
    const stub = env.SHARED_CART.get(id);

    return stub.fetch(request);
  }
};
