// Hardcoded response for GET <guest API>?eventId=<id>, in the exact shape the backend returns.
// Used while VITE_GUESTS_USE_MOCK is not "false" (see guestApi.ts).
export const mockGuestListResponse = {
  count: 2,
  guests: [
    {
      eventId: "42",
      guestId: "7f3c9a2e-1b4d-4e8a-9c21-5d6f8a0b3e17",
      firstName: "Sofia",
      lastName: "Martinez",
      email: "sofia@example.com",
      plusOneAllowed: true,
      mealChoice: "Vegetarian",
      dietaryNotes: "No nuts",
      rsvpStatus: "PENDING",
      createdAt: "2026-11-12T18:30:00.000Z",
      updatedAt: "2026-11-12T18:30:00.000Z",
    },
    {
      eventId: "42",
      guestId: "7f3538fe-1b4d-4e8a-9c21-5d6f8a0b3e17",
      firstName: "John",
      lastName: "Smith",
      email: "john@example.com",
      plusOneAllowed: true,
      mealChoice: "Vegetarian",
      dietaryNotes: "No nuts",
      rsvpStatus: "PENDING",
      createdAt: "2026-11-12T18:30:00.000Z",
      updatedAt: "2026-11-12T18:30:00.000Z",
    },
  ],
};
