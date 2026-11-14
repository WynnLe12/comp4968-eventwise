import { Button, Modal } from "../../../components/ui";

export function DeleteEventDialog({ name, loading, error, onClose, onConfirm }: {
  name: string; loading: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  return <Modal title="Delete Event?" onClose={onClose} footer={<>
    <Button type="button" variant="secondary" disabled={loading} onClick={onClose}>Cancel</Button>
    <Button type="button" variant="danger" disabled={loading} onClick={onConfirm}>{loading ? "Deleting..." : "Delete Event"}</Button>
  </>}>
    <p><strong>{name}</strong></p>
    <p>Are you sure you want to delete this event? This action cannot be undone.</p>
    {error && <p className="expense-form-error" role="alert">{error}</p>}
  </Modal>;
}
