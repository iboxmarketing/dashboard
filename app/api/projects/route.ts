import {
  createProject, createProjectUpdate, deleteProjectUpdate, listProjectUpdates,
  listProjects, setProjectArchived, updateProject, updateProjectUpdate,
} from "@/lib/projects-storage";
import { validateProjectInput, validateUpdateInput } from "@/lib/projects";

export async function GET() {
  try {
    const [projects, updates] = await Promise.all([listProjects(), listProjectUpdates()]);
    return Response.json({ projects, updates });
  } catch {
    return Response.json({ error: "Loyihalarni yuklab bo‘lmadi" }, { status: 500 });
  }
}

/** Every payload is validated server-side; ids are never trusted as content. */
export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const id = String(payload.id ?? "").trim();

    if (action === "createProject" || action === "updateProject") {
      const parsed = validateProjectInput(payload);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      if (action === "createProject") return Response.json({ id: await createProject(parsed.value) });
      if (!id) return Response.json({ error: "Loyiha ID kerak" }, { status: 400 });
      await updateProject(id, parsed.value);
      return Response.json({ ok: true });
    }

    if (action === "archiveProject" || action === "restoreProject") {
      if (!id) return Response.json({ error: "Loyiha ID kerak" }, { status: 400 });
      await setProjectArchived(id, action === "archiveProject");
      return Response.json({ ok: true });
    }

    if (action === "createUpdate" || action === "updateUpdate") {
      const parsed = validateUpdateInput(payload);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      if (action === "createUpdate") return Response.json({ id: await createProjectUpdate(parsed.value) });
      if (!id) return Response.json({ error: "Update ID kerak" }, { status: 400 });
      await updateProjectUpdate(id, parsed.value);
      return Response.json({ ok: true });
    }

    if (action === "deleteUpdate") {
      if (!id) return Response.json({ error: "Update ID kerak" }, { status: 400 });
      await deleteProjectUpdate(id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Noma’lum amal" }, { status: 400 });
  } catch {
    return Response.json({ error: "Amalni bajarib bo‘lmadi" }, { status: 500 });
  }
}
