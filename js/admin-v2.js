import { supabase, signedAssetUrl } from "./supabase.js?v=20260623-2";

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "./admin-v2.css?v=20260624-user-table";
document.head.appendChild(style);

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
);

let initialized = false;
let packRows = [];

async function setDeliveryImage(image, storagePath) {
  if (!image || !storagePath) return;
  try {
    const url = await signedAssetUrl(storagePath);
    if (image.isConnected) image.src = url;
  } catch (error) {
    console.error("Delivery image failed", error);
  }
}

function packThumbnailPath(pack) {
  return pack.thumbnail_path
    || [...(pack.stickers || [])].sort((a, b) => (a.position || 0) - (b.position || 0))[0]?.storage_path
    || [...(pack.backgrounds || [])].sort((a, b) => (a.position || 0) - (b.position || 0))[0]?.storage_path
    || "";
}

function productThumbnailPath(product) {
  if (product.thumbnail_storage_path) return product.thumbnail_storage_path;
  const packIds = new Set((product.product_packs || []).map((row) => row.pack_id));
  return packRows.map((pack) => packIds.has(pack.id) ? packThumbnailPath(pack) : "").find(Boolean) || "";
}

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
    <button class="tab" data-tab="users">계정 관리</button>
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
    <section id="users-panel" class="delivery-panel" hidden>
      <div class="delivery-toolbar">
        <input id="user-search" class="user-search" placeholder="닉네임 또는 사용자 ID 검색">
        <button id="users-refresh" class="button secondary">새로고침</button>
        <span class="delivery-note">닉네임, 포인트, 팩 사용권한을 관리합니다.</span>
      </div>
      <div id="user-list" class="user-management"></div>
    </section>
  `);

  document.querySelectorAll(".tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const current = tab.dataset.tab;
      $("#products-panel").hidden = current !== "products";
      $("#entitlements-panel").hidden = current !== "entitlements";
      $("#users-panel").hidden = current !== "users";
      if (current === "packs") loadPackDelivery();
      if (current === "products") loadProducts();
      if (current === "entitlements") loadEntitlements();
      if (current === "users") loadUsers();
    });
  });

  $("#refresh-pack-delivery").onclick = loadPackDelivery;
  $("#publish-release").onclick = publishRelease;
  $("#products-refresh").onclick = loadProducts;
  $("#new-product").onclick = () => editProduct();
  $("#grant-entitlement").onclick = grantEntitlement;
  $("#users-refresh").onclick = loadUsers;
  $("#user-search").oninput = renderUsers;

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
    .select("id,name,published,access_level,stickers(storage_path,position),backgrounds(storage_path,position)")
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
      const thumbnailPath = productThumbnailPath(product);
      card.innerHTML = `
        <div class="product-card__thumb">
          ${thumbnailPath ? `<img alt="">` : `<span>＋</span>`}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="delivery-note">${Number(product.price_amount).toLocaleString()} ${escapeHtml(product.currency)}
        · 팩 ${product.product_packs?.length || 0}개 · ${product.published ? "판매 중" : "비공개"}</p>
        <div class="delivery-toolbar">
          <button class="button edit-product">수정</button>
          <button class="button danger delete-product">삭제</button>
        </div>
      `;
      if (thumbnailPath) {
        setDeliveryImage(card.querySelector(".product-card__thumb img"), thumbnailPath);
      }
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
      <label class="product-image-field">
        <span>상품 홍보 이미지</span>
        <input name="productImage" type="file" accept="image/*">
      </label>
      <label><input name="published" type="checkbox" ${product?.published ? "checked" : ""}> 상점에 공개</label>
      <strong>포함 팩</strong>
      <div class="delivery-assets">
        ${packRows.map((pack) => `
          <label class="pack-option">
            <input type="checkbox" name="pack" value="${pack.id}" ${selected.has(pack.id) ? "checked" : ""}>
            <span class="pack-option__thumb">${packThumbnailPath(pack) ? `<img data-path="${escapeHtml(packThumbnailPath(pack))}" alt="">` : "＋"}</span>
            <span>${escapeHtml(pack.name)} · ${pack.access_level === "paid" ? "유료" : "무료"}</span>
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
  overlay.querySelectorAll(".pack-option__thumb img").forEach((image) => {
    setDeliveryImage(image, image.dataset.path);
  });
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
    const imageFile = form.get("productImage");
    if (imageFile && imageFile.size) {
      const safeName = imageFile.name.replace(/[^\w.-]+/g, "-");
      const imagePath = `products/${Date.now()}-${safeName}`;
      const upload = await supabase.storage
        .from("assets")
        .upload(imagePath, imageFile, { contentType: imageFile.type || "image/png", upsert: true });
      if (upload.error) return toast("상품 이미지를 업로드하지 못했어요.");
      payload.thumbnail_storage_path = imagePath;
    } else if (product?.thumbnail_storage_path) {
      payload.thumbnail_storage_path = product.thumbnail_storage_path;
    }
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

let userRows = [];
let userEntitlements = new Map();
let userProductPurchases = new Map();
let userPointPurchases = new Map();
let selectedUserId = null;

async function loadUsers() {
  try {
    const [packs, profiles, entitlements, productPurchases, pointPurchases] = await Promise.all([
      supabase
        .from("sticker_packs")
        .select("id,name,access_level,published")
        .order("position"),
      supabase
        .from("account_profiles")
        .select("user_id,email,display_name,points,created_at,updated_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("user_pack_entitlements")
        .select("user_id,pack_id,source_type,revoked_at"),
      supabase
        .from("user_purchases")
        .select("id,user_id,status,purchased_at,products(name,price_amount,currency)")
        .order("purchased_at", { ascending: false })
        .limit(200),
      supabase
        .from("point_purchases")
        .select("id,user_id,points,price_amount,currency,status,purchased_at")
        .order("purchased_at", { ascending: false })
        .limit(200),
    ]);
    if (packs.error || profiles.error || entitlements.error) {
      throw packs.error || profiles.error || entitlements.error;
    }

    packRows = packs.data || [];
    userRows = profiles.data || [];
    userEntitlements = new Map();
    for (const row of entitlements.data || []) {
      if (row.revoked_at) continue;
      if (!userEntitlements.has(row.user_id)) {
        userEntitlements.set(row.user_id, new Set());
      }
      userEntitlements.get(row.user_id).add(row.pack_id);
    }
    userProductPurchases = groupRowsByUser(productPurchases.error ? [] : productPurchases.data || []);
    userPointPurchases = groupRowsByUser(pointPurchases.error ? [] : pointPurchases.data || []);
    if (selectedUserId && !userRows.some((user) => user.user_id === selectedUserId)) {
      selectedUserId = null;
    }
    renderUsers();
  } catch (error) {
    console.error(error);
    toast("계정 정보를 불러오지 못했어요. SQL과 관리자 권한을 확인하세요.");
  }
}

function groupRowsByUser(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.user_id)) grouped.set(row.user_id, []);
    grouped.get(row.user_id).push(row);
  }
  return grouped;
}

function renderUsers() {
  const list = $("#user-list");
  if (!list) return;
  const query = ($("#user-search")?.value || "").trim().toLowerCase();
  const filtered = userRows.filter((user) => {
    const text = `${user.display_name || ""} ${user.user_id || ""}`.toLowerCase();
    return !query || text.includes(query);
  });
  list.innerHTML = `
    <div class="user-table">
      <div class="user-table__head">
        <span></span>
        <span>UID</span>
        <span>Display name</span>
        <span>Email</span>
        <span>Points</span>
        <span>Created at</span>
        <span>Updated at</span>
      </div>
      ${filtered.map(renderUserListItem).join("") || `<p class="delivery-note">검색 결과가 없어요.</p>`}
    </div>
  `;
  list.querySelectorAll(".user-list-item").forEach((item) => {
    item.onclick = () => {
      selectedUserId = selectedUserId === item.dataset.userId ? null : item.dataset.userId;
      renderUsers();
    };
  });
  list.querySelectorAll(".user-save").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const detail = button.closest(".user-expanded");
      const profile = userRows.find((user) => user.user_id === detail.dataset.userId);
      if (profile) saveUserDetail(profile, detail);
    };
  });
}

function renderUserListItem(user) {
  const count = userEntitlements.get(user.user_id)?.size || 0;
  const expanded = user.user_id === selectedUserId;
  return `
    <div class="user-table__item">
      <button class="user-list-item ${expanded ? "is-on" : ""}" data-user-id="${escapeHtml(user.user_id)}">
        <span class="user-chevron">${expanded ? "⌄" : "›"}</span>
        <code>${escapeHtml(user.user_id)}</code>
        <strong>${escapeHtml(user.display_name || "-")}</strong>
        <span>${escapeHtml(user.email || "-")}</span>
        <span>${Number(user.points || 0).toLocaleString()} P</span>
        <span>${formatDate(user.created_at)}</span>
        <span>${formatDate(user.updated_at)}</span>
      </button>
      ${expanded ? renderUserExpanded(user, count) : ""}
    </div>
  `;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("ko-KR") : "-";
}

function renderUserExpanded(profile, count) {
  const activePackIds = userEntitlements.get(profile.user_id) || new Set();
  const productRows = userProductPurchases.get(profile.user_id) || [];
  const pointRows = userPointPurchases.get(profile.user_id) || [];
  return `
    <div class="user-expanded" data-user-id="${escapeHtml(profile.user_id)}">
      <div class="user-card__head">
        <div>
          <h3>${escapeHtml(profile.display_name || "-")}</h3>
          <code>${escapeHtml(profile.user_id)}</code>
        </div>
        <button class="button user-save" type="button">저장</button>
      </div>
      <label>닉네임</label>
      <input class="user-name" value="${escapeHtml(profile.display_name || "")}" maxlength="20">
      <label>보유 포인트</label>
      <input class="user-points" type="number" min="0" step="1" value="${Number(profile.points || 0)}">
      <div class="user-expanded__grid">
        ${renderHistory("최근 포인트 구매 내역", pointRows, renderPointPurchase)}
        ${renderHistory("최근 상품 구매 내역", productRows, renderProductPurchase)}
      </div>
      <details class="user-pack-dropdown">
        <summary>사용가능 팩 ${count}개</summary>
        <div class="user-pack-table">
          ${packRows.map((pack) => `
            <div class="user-pack-row">
              <span>${escapeHtml(pack.name)}</span>
              <em>${pack.access_level === "paid" ? "유료" : "무료"}${pack.published ? "" : " · 비공개"}</em>
              <select data-pack-id="${pack.id}">
                <option value="enabled" ${activePackIds.has(pack.id) ? "selected" : ""}>사용 가능</option>
                <option value="disabled" ${activePackIds.has(pack.id) ? "" : "selected"}>불가능</option>
              </select>
            </div>
          `).join("")}
        </div>
      </details>
    </div>
  `;
}

function renderHistory(title, rows, renderer) {
  return `
    <section class="user-history">
      <h4>${title}</h4>
      ${rows.slice(0, 5).map(renderer).join("") || `<p class="delivery-note">내역 없음</p>`}
    </section>
  `;
}

function renderPointPurchase(row) {
  return `
    <div class="user-history-row">
      <strong>${Number(row.points || 0).toLocaleString()} P</strong>
      <span>${Number(row.price_amount || 0).toLocaleString()} ${escapeHtml(row.currency || "KRW")}</span>
      <em>${escapeHtml(row.status || "-")} · ${formatDate(row.purchased_at)}</em>
    </div>
  `;
}

function renderProductPurchase(row) {
  return `
    <div class="user-history-row">
      <strong>${escapeHtml(row.products?.name || "상품")}</strong>
      <span>${Number(row.products?.price_amount || 0).toLocaleString()} ${escapeHtml(row.products?.currency || "KRW")}</span>
      <em>${escapeHtml(row.status || "-")} · ${formatDate(row.purchased_at)}</em>
    </div>
  `;
}

async function saveUserDetail(profile, detail) {
  const display_name = detail.querySelector(".user-name").value.trim();
  const points = Number(detail.querySelector(".user-points").value || 0);
  if (!display_name) return toast("닉네임을 입력하세요.");
  if (!Number.isFinite(points) || points < 0) return toast("포인트를 확인하세요.");

  const { error: profileError } = await supabase
    .from("account_profiles")
    .update({ display_name, points: Math.floor(points) })
    .eq("user_id", profile.user_id);
  if (profileError) return toast("계정 정보를 저장하지 못했어요.");

  const selectedPackIds = new Set(
    Array.from(detail.querySelectorAll(".user-pack-row select"))
      .filter((select) => select.value === "enabled")
      .map((select) => select.dataset.packId),
  );
  const allPackIds = packRows.map((pack) => pack.id);
  const grantRows = allPackIds
    .filter((pack_id) => selectedPackIds.has(pack_id))
    .map((pack_id) => ({
      user_id: profile.user_id,
      pack_id,
      source_type: "admin",
      revoked_at: null,
    }));
  if (grantRows.length) {
    const { error: grantError } = await supabase
      .from("user_pack_entitlements")
      .upsert(grantRows, { onConflict: "user_id,pack_id" });
    if (grantError) return toast("팩 권한을 저장하지 못했어요.");
  }

  const revokedPackIds = allPackIds.filter((pack_id) => !selectedPackIds.has(pack_id));
  if (revokedPackIds.length) {
    const { error: revokeError } = await supabase
      .from("user_pack_entitlements")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", profile.user_id)
      .in("pack_id", revokedPackIds);
    if (revokeError) return toast("팩 권한 해제에 실패했어요.");
  }

  toast("계정 정보를 저장했어요.");
  loadUsers();
}
injectAdminUi();
