import { supabase } from "./supabase.js?v=20260623-2";

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "./admin-v2.css?v=20260623-2";
document.head.appendChild(style);

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
);

let initialized = false;
let packRows = [];

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2400);
}

function injectAdminUi() {
  if (initialized || !$("#dashboard") || !$(".tabs") || !$("#packs-panel")) return;
  initialized = true;

  $(".tabs").insertAdjacentHTML("beforeend", `
    <button class="tab" data-tab="products">상품</button>
    <button class="tab" data-tab="entitlements">사용자 권한</button>
  `);
  $("#packs-panel").insertAdjacentHTML("afterbegin", `
    <div class="delivery-toolbar pack-release-toolbar">
      <strong>팩 배포 관리</strong>
      <span>현재 버전 <b id="catalog-version">-</b></span>
      <button id="refresh-pack-delivery" class="button secondary">새로고침</button>
      <button id="publish-release" class="button">업데이트 배포</button>
      <span class="delivery-note">각 팩에서 공개·무료·유료를 설정한 뒤 배포하세요.</span>
    </div>
  `);
  $("#dashboard").insertAdjacentHTML("beforeend", `
    <section id="products-panel" class="delivery-panel" hidden>
      <div class="delivery-toolbar">
        <button id="new-product" class="button">+ 상품 추가</button>
        <button id="products-refresh" class="button secondary">새로고침</button>
      </div>
      <div id="product-list" class="delivery-grid"></div>
    </section>
    <section id="entitlements-panel" class="delivery-panel" hidden>
      <div class="delivery-card">
        <h3>상품 권한 수동 부여</h3>
        <p class="delivery-note">결제 테스트나 고객 지원용입니다.</p>
        <div class="form">
          <input id="entitlement-user-id" placeholder="사용자 UUID">
          <select id="entitlement-product"></select>
          <button id="grant-entitlement" class="button">권한 부여</button>
        </div>
      </div>
      <div class="delivery-card">
        <h3>최근 구매·부여 기록</h3>
        <div id="purchase-list"></div>
      </div>
    </section>
  `);

  document.querySelectorAll(".tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const current = tab.dataset.tab;
      $("#products-panel").hidden = current !== "products";
      $("#entitlements-panel").hidden = current !== "entitlements";
      if (current === "packs") loadPackDelivery();
      if (current === "products") loadProducts();
      if (current === "entitlements") loadEntitlements();
    });
  });

  $("#refresh-pack-delivery").onclick = loadPackDelivery;
  $("#publish-release").onclick = publishRelease;
  $("#products-refresh").onclick = loadProducts;
  $("#new-product").onclick = () => editProduct();
  $("#grant-entitlement").onclick = grantEntitlement;

  new MutationObserver(() => decoratePackCards()).observe($("#pack-list"), {
    childList: true,
    subtree: false,
  });
  loadPackDelivery();
}

async function loadPackDelivery() {
  const [settings, packs] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "asset_catalog_version").maybeSingle(),
    supabase.from("sticker_packs")
      .select("id,name,published,access_level,content_version")
      .order("position"),
  ]);
  if (settings.error || packs.error) {
    return toast("팩 배포 정보를 불러오지 못했어요. 최신 SQL을 실행하세요.");
  }
  packRows = packs.data || [];
  $("#catalog-version").textContent = settings.data?.value ?? 1;
  decoratePackCards();
}

function decoratePackCards() {
  const packsById = new Map(packRows.map((pack) => [pack.id, pack]));
  document.querySelectorAll("#pack-list .pack").forEach((card) => {
    const pack = packsById.get(card.dataset.sortId);
    if (!pack) return;
    let controls = card.querySelector(".pack-delivery-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "pack-delivery-controls";
      card.querySelector(".pack__top")?.appendChild(controls);
    }
    controls.innerHTML = `
      <label><input class="pack-published" type="checkbox" ${pack.published ? "checked" : ""}> 앱에 공개</label>
      <select class="pack-access">
        <option value="free" ${pack.access_level === "free" ? "selected" : ""}>무료 팩</option>
        <option value="paid" ${pack.access_level === "paid" ? "selected" : ""}>유료 팩</option>
      </select>
      <button class="button pack-delivery-save">저장</button>
    `;
    controls.querySelector(".pack-delivery-save").onclick = async () => {
      const published = controls.querySelector(".pack-published").checked;
      const access_level = controls.querySelector(".pack-access").value;
      const { error } = await supabase.from("sticker_packs").update({
        published,
        access_level,
        content_version: Number(pack.content_version || 1) + 1,
      }).eq("id", pack.id);
      if (error) return toast("팩 설정을 저장하지 못했어요.");
      toast("팩 설정을 저장했어요. 완료 후 업데이트를 배포하세요.");
      loadPackDelivery();
    };
  });
}

async function publishRelease() {
  if (!confirm("현재 팩 변경사항을 앱에 배포할까요?")) return;
  const { data, error } = await supabase.rpc("bump_asset_catalog_version");
  if (error) return toast("배포하지 못했어요. 최신 SQL을 확인하세요.");
  $("#catalog-version").textContent = data;
  toast(`카탈로그 ${data} 버전을 배포했어요.`);
}

async function fetchPacks() {
  const { data, error } = await supabase
    .from("sticker_packs")
    .select("id,name,published,access_level")
    .order("position");
  if (error) throw error;
  packRows = data || [];
  return packRows;
}

async function loadProducts() {
  try {
    await fetchPacks();
    const { data, error } = await supabase
      .from("products")
      .select("*,product_packs(pack_id)")
      .order("position");
    if (error) throw error;
    const list = $("#product-list");
    list.innerHTML = "";
    for (const product of data || []) {
      const card = document.createElement("div");
      card.className = "delivery-card";
      card.innerHTML = `
        <h3>${escapeHtml(product.name)}</h3>
        <p class="delivery-note">${Number(product.price_amount).toLocaleString()} ${escapeHtml(product.currency)}
        · 팩 ${product.product_packs?.length || 0}개 · ${product.published ? "판매 중" : "비공개"}</p>
        <div class="delivery-toolbar">
          <button class="button edit-product">수정</button>
          <button class="button danger delete-product">삭제</button>
        </div>
      `;
      card.querySelector(".edit-product").onclick = () => editProduct(product);
      card.querySelector(".delete-product").onclick = async () => {
        if (!confirm(`"${product.name}" 상품을 삭제할까요?`)) return;
        const { error: removeError } = await supabase.from("products").delete().eq("id", product.id);
        if (removeError) return toast("상품을 삭제하지 못했어요.");
        loadProducts();
      };
      list.appendChild(card);
    }
  } catch (error) {
    console.error(error);
    toast("상품 정보를 불러오지 못했어요. 최신 SQL을 실행하세요.");
  }
}

async function editProduct(product = null) {
  if (!packRows.length) {
    try { await fetchPacks(); } catch (_) { return toast("팩을 불러오지 못했어요."); }
  }
  const selected = new Set((product?.product_packs || []).map((row) => row.pack_id));
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <form class="modal__card">
      <h2>${product ? "상품 수정" : "상품 추가"}</h2>
      <input name="name" placeholder="상품 이름" value="${escapeHtml(product?.name || "")}" required>
      <textarea name="description" rows="3" placeholder="상품 설명">${escapeHtml(product?.description || "")}</textarea>
      <input name="price" type="number" min="0" placeholder="가격(원)" value="${product?.price_amount || 0}">
      <label><input name="published" type="checkbox" ${product?.published ? "checked" : ""}> 상점에 공개</label>
      <strong>포함 팩</strong>
      <div class="delivery-assets">
        ${packRows.map((pack) => `
          <label>
            <input type="checkbox" name="pack" value="${pack.id}" ${selected.has(pack.id) ? "checked" : ""}>
            ${escapeHtml(pack.name)} · ${pack.access_level === "paid" ? "유료" : "무료"}
          </label>
        `).join("")}
      </div>
      <div class="modal__actions">
        <button type="button" class="button secondary cancel">취소</button>
        <button class="button">저장</button>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".cancel").onclick = () => overlay.remove();
  overlay.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name")).trim(),
      description: String(form.get("description")).trim(),
      product_type: form.getAll("pack").length > 1 ? "bundle" : "pack",
      price_amount: Number(form.get("price") || 0),
      currency: "KRW",
      published: form.get("published") === "on",
      position: product?.position || Date.now(),
    };
    const query = product
      ? supabase.from("products").update(payload).eq("id", product.id).select().single()
      : supabase.from("products").insert(payload).select().single();
    const { data: saved, error } = await query;
    if (error) return toast("상품을 저장하지 못했어요.");
    await supabase.from("product_packs").delete().eq("product_id", saved.id);
    const packs = form.getAll("pack").map((pack_id) => ({
      product_id: saved.id,
      pack_id,
    }));
    if (packs.length) {
      const { error: packError } = await supabase.from("product_packs").insert(packs);
      if (packError) return toast("상품 팩을 저장하지 못했어요.");
    }
    overlay.remove();
    toast("상품을 저장했어요.");
    loadProducts();
  };
}

async function loadEntitlements() {
  const [products, purchases] = await Promise.all([
    supabase.from("products").select("id,name").order("name"),
    supabase.from("user_purchases")
      .select("id,user_id,product_id,status,purchased_at,products(name)")
      .order("purchased_at", { ascending: false })
      .limit(50),
  ]);
  if (products.error || purchases.error) return toast("권한 정보를 불러오지 못했어요.");
  $("#entitlement-product").innerHTML = (products.data || [])
    .map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`)
    .join("");
  $("#purchase-list").innerHTML = (purchases.data || []).map((purchase) => `
    <div class="delivery-row">
      <strong>${escapeHtml(purchase.products?.name || purchase.product_id)}</strong>
      <span>${escapeHtml(purchase.user_id)}</span>
      <span>${escapeHtml(purchase.status)}</span>
      <span>${new Date(purchase.purchased_at).toLocaleString("ko-KR")}</span>
    </div>
  `).join("") || `<p class="delivery-note">아직 기록이 없어요.</p>`;
}

async function grantEntitlement() {
  const target_user_id = $("#entitlement-user-id").value.trim();
  const target_product_id = $("#entitlement-product").value;
  if (!target_user_id || !target_product_id) return toast("사용자 UUID와 상품을 입력하세요.");
  const { error } = await supabase.rpc("admin_grant_product", {
    target_user_id,
    target_product_id,
  });
  if (error) return toast("권한을 부여하지 못했어요. UUID와 SQL을 확인하세요.");
  $("#entitlement-user-id").value = "";
  toast("상품 권한을 부여했어요.");
  loadEntitlements();
}

injectAdminUi();
