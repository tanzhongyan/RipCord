"use client";

import { useState } from "react";
import { api } from "~/trpc/react";

export function Notes() {
  const [notesList] = api.notes.list.useSuspenseQuery();
  const utils = api.useUtils();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const createNote = api.notes.create.useMutation({
    onSuccess: async () => {
      await utils.notes.invalidate();
      setTitle("");
      setBody("");
    },
  });

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">Notes</h2>
        {notesList.length === 0 ? (
          <p className="text-sm text-gray-300">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notesList.map((note) => (
              <li key={note.id} className="rounded-lg bg-white/10 p-3">
                <h3 className="font-semibold">{note.title}</h3>
                {note.body ? <p className="text-sm text-gray-200">{note.body}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) {
            createNote.mutate({ title, body });
          }
        }}
        className="flex flex-col gap-2"
      >
        <input
          type="text"
          placeholder="Note title (1-200 characters)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          className="rounded-lg bg-white/10 px-4 py-2 text-white"
        />
        <textarea
          placeholder="Note body (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="rounded-lg bg-white/10 px-4 py-2 text-white"
        />
        <button
          type="submit"
          disabled={createNote.isPending || !title.trim()}
          className="rounded-lg bg-white/20 px-4 py-2 font-semibold transition hover:bg-white/30 disabled:opacity-50"
        >
          {createNote.isPending ? "Creating..." : "Create Note"}
        </button>
      </form>
    </div>
  );
}
