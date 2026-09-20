import { authError, requireAdmin } from "@/lib/auth/http";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import { normalizePermissions } from "@/lib/auth/permissions";
import { countActiveAdminsExcluding, createUser, findUserById, listUsers, updateUser } from "@/lib/auth/storage";
import { isAuthRole, normalizeEmail } from "@/lib/auth/types";

function validIdentity(email: string, name: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return "Email noto‘g‘ri";
  if (name.length < 2 || name.length > 120) return "Ism 2–120 belgi bo‘lishi kerak";
  return null;
}
function duplicateEmail(error: unknown) { return error instanceof Error && /unique|constraint.*email/iu.test(error.message); }

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return Response.json({ users: await listUsers() }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return authError(error) ?? Response.json({ error: "Foydalanuvchilarni yuklab bo‘lmadi" }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const email = normalizeEmail(payload.email);
    const name = String(payload.name ?? "").trim();
    const role = payload.role;
    const identityError = validIdentity(email, name);
    if (identityError) return Response.json({ error: identityError }, { status: 400 });
    if (!isAuthRole(role)) return Response.json({ error: "Rol noto‘g‘ri" }, { status: 400 });
    const checked = validatePassword(payload.temporaryPassword);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const id = await createUser({ email, name, role, passwordHash: await hashPassword(checked.value), permissions: normalizePermissions(payload.permissions), mustChangePassword: true });
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (duplicateEmail(error)) return Response.json({ error: "Bu email allaqachon mavjud" }, { status: 409 });
    return authError(error) ?? Response.json({ error: "Foydalanuvchini yaratib bo‘lmadi" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const caller = await requireAdmin(request);
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(payload.id ?? "").trim();
    const existing = id ? await findUserById(id) : null;
    if (!existing) return Response.json({ error: "Foydalanuvchi topilmadi" }, { status: 404 });
    const role = payload.role === undefined ? existing.role : payload.role;
    const active = payload.active === undefined ? existing.active : payload.active;
    if (!isAuthRole(role) || typeof active !== "boolean") return Response.json({ error: "Rol yoki holat noto‘g‘ri" }, { status: 400 });
    const email = payload.email === undefined ? existing.email : normalizeEmail(payload.email);
    const name = payload.name === undefined ? existing.name : String(payload.name).trim();
    const identityError = validIdentity(email, name);
    if (identityError) return Response.json({ error: identityError }, { status: 400 });
    if (id === caller.user.id && (!active || role !== "ADMIN")) return Response.json({ error: "Administrator o‘z rolini olib tashlay yoki o‘zini o‘chira olmaydi" }, { status: 400 });
    if (existing.role === "ADMIN" && existing.active && (!active || role !== "ADMIN") && await countActiveAdminsExcluding(id) === 0) {
      return Response.json({ error: "Oxirgi faol administratorni o‘chirib bo‘lmaydi" }, { status: 400 });
    }
    let passwordHash: string | undefined;
    if (payload.temporaryPassword !== undefined) {
      const checked = validatePassword(payload.temporaryPassword);
      if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
      passwordHash = await hashPassword(checked.value);
    }
    await updateUser({
      id, email, name, role, active, passwordHash,
      mustChangePassword: passwordHash ? true : payload.mustChangePassword === undefined ? undefined : payload.mustChangePassword === true,
      permissions: payload.permissions === undefined ? undefined : normalizePermissions(payload.permissions),
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (duplicateEmail(error)) return Response.json({ error: "Bu email allaqachon mavjud" }, { status: 409 });
    return authError(error) ?? Response.json({ error: "Foydalanuvchini yangilab bo‘lmadi" }, { status: 500 });
  }
}
