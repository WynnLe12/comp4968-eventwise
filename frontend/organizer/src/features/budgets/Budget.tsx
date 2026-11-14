import { useEffect, useRef, useState } from "react";
import { useEvents } from "../events/EventsContext";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";
import { budgetDefaults } from "../../data/mockData";
import {
  fetchBudgetCategories,
  editBudgetCategory,
  addBudgetCategory,
  removeBudgetCategory,
  saveTotalBudget,
  type BudgetCategory,
  type EventBudgetResponse,
} from "./budgetApi";

const SPENT_TOTAL = 22440;
const spentByCategory = [12800, 4200, 1900, 2850, 690, 0, 0];

interface BudgetProps {
  openReset: () => void;
}

function formatMoney(amount: number): string {
  return amount.toLocaleString("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function calculatePlannedCents(
  totalCents: number,
  percentage: string | null
): number {
  const percentageUnits = Math.round(Number(percentage ?? 0) * 100);
  return Math.round((totalCents * percentageUnits) / 10000);
}

export function Budget({ openReset }: BudgetProps) {
  const { selectedId: eventId, eventDetails, reloadDetails, } = useEvents();
  // Track the currently selected event across asynchronous requests.
  const activeEventIdRef = useRef(eventId);
  activeEventIdRef.current = eventId;

  function isActiveEvent(requestEventId: string): boolean {
    return activeEventIdRef.current === requestEventId;
  }

  const canEditTotalBudget = eventDetails?.role === "OWNER";
  // Original mock-data page.
  const [total, setTotal] = useState(35000);
  const [categories, setCategories] = useState(budgetDefaults);

  const allocated = categories.reduce(
    (sum, category) =>
      sum + Math.round((total * category.pct) / 100),
    0
  );

  // Real event budget state.
  const [budgetData, setBudgetData] = useState<EventBudgetResponse | null>(null);

  const [draftCategories, setDraftCategories] = useState<BudgetCategory[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Add Category form state.
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [editingTotal, setEditingTotal] = useState(false);
  const [savingTotal, setSavingTotal] = useState(false);
  const [newTotalBudget, setNewTotalBudget] = useState("");
  const [recalculationMode, setRecalculationMode] = useState<"recalculate" | "keep">("recalculate");

  // Load actual budget data when an event is selected.
  useEffect(() => {

    if (!eventId) {
      setBudgetData(null);
      setDraftCategories([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadBudget() {
      setLoading(true);
      setEditingTotal(false);
      setNewTotalBudget("");
      setRecalculationMode("recalculate");
      setShowAddCategory(false);
      setNewCategoryName("");
      setSaveMessage(null);
      setError(null);
      setBudgetData(null);
      setDraftCategories([]);
      setSaveMessage(null);

      try {
        const data = await fetchBudgetCategories(eventId!);

        if (!cancelled) {
          setBudgetData(data);
          setDraftCategories(
            data.categories.map((category) => ({ ...category }))
          );
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load budget categories"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadBudget();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // Update a category's percentage in local state.
  function updateAllocation(categoryId: string, percentage: string) {
    if (
      percentage !== "" &&
      (
        !/^\d{1,3}(\.\d{0,2})?$/.test(percentage) ||
        Number(percentage) > 100
      )
    ) {
      return;
    }

    setDraftCategories((previous) =>
      previous.map((category) =>
        category.categoryId === categoryId
          ? { ...category, allocationPercentage: percentage }
          : category
      )
    );

    setSaveMessage(null);
  }

  function updateCategoryName(
    categoryId: string,
    newName: string
  ) {
    if (newName.length > 100) {
      return;
    }

    setDraftCategories((previous) =>
      previous.map((category) =>
        category.categoryId === categoryId
          ? { ...category, name: newName }
          : category
      )
    );

    setSaveMessage(null);
  }

  // Add a new category locally. It is saved when Save Changes is clicked.
  function handleAddCategory() {
    const name = newCategoryName.trim();

    if (!name) {
      setSaveMessage("Please enter a category name.");
      return;
    }

    if (name.length > 100) {
      setSaveMessage("Category name must be 100 characters or less.");
      return;
    }

    if (
      draftCategories.some(
        (category) =>
          category.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      setSaveMessage("A category with this name already exists.");
      return;
    }

    const newCategory: BudgetCategory = {
      categoryId: `new-${Date.now()}`,
      eventId: eventId ?? "",
      name,
      allocationPercentage: "0.00",
      plannedAmount: "0.00",
      sortOrder:
        Math.max(0, ...draftCategories.map((c) => c.sortOrder)) + 1,
    };

    setDraftCategories((previous) => [...previous, newCategory]);
    setNewCategoryName("");
    setShowAddCategory(false);
    setSaveMessage(null);
  }

  async function handleDeleteCategory(categoryId: string) {
    const category = draftCategories.find(
      (item) => item.categoryId === categoryId
    );

    if (!category || saving) {
      return;
    }

    if (savingTotal) {
      setSaveMessage(
        "Please finish updating the total budget first."
      );
      return;
    }

    const hasUnsavedChanges =
      draftCategories.length !== (budgetData?.categories.length ?? 0) ||
      draftCategories.some((draft) => {
        const original = budgetData?.categories.find(
          (item) => item.categoryId === draft.categoryId
        );

        return (
          !original ||
          draft.name !== original.name ||
          draft.allocationPercentage !== original.allocationPercentage ||
          draft.sortOrder !== original.sortOrder
        );
      });

    if (
      !categoryId.startsWith("new-") &&
      hasUnsavedChanges
    ) {
      setSaveMessage(
        "Please save your category changes before deleting an existing category."
      );
      return;
    }

    // New categories do not exist in MySQL yet.
    if (categoryId.startsWith("new-")) {
      setDraftCategories((previous) =>
        previous.filter(
          (item) => item.categoryId !== categoryId
        )
      );

      setSaveMessage("Unsaved category removed.");
      return;
    }

    // Existing categories require an event and authentication.
    if (!eventId) {
      setSaveMessage("Authentication required.");
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to delete "${category.name}"?`
    );

    if (!confirmed) {
      return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      await removeBudgetCategory(eventId, categoryId);

      // Reload categories from MySQL.
      const updatedBudget = await fetchBudgetCategories(eventId);

      setBudgetData(updatedBudget);
      setDraftCategories(
        updatedBudget.categories.map((item) => ({
          ...item,
        }))
      );

      setSaveMessage("Budget category deleted successfully.");
    } catch (err: unknown) {
      setSaveMessage(
        err instanceof Error
          ? `Delete failed: ${err.message}`
          : "Failed to delete budget category."
      );
    } finally {
      setSaving(false);
    }
  }

  const realTotal = Number(budgetData?.totalBudget ?? 0);
  const totalCents = Math.round(realTotal * 100);

  const realAllocatedCents = draftCategories.reduce(
    (sum, category) =>
      sum + calculatePlannedCents(
        totalCents,
        category.allocationPercentage
      ),
    0
  );

  const realAllocated = realAllocatedCents / 100;
  const realUnallocated = (totalCents - realAllocatedCents) / 100;

  const realAllocationPercent = draftCategories.reduce(
    (sum, category) =>
      sum + Number(category.allocationPercentage ?? 0),
    0
  );

  const isOverAllocated =
    Math.round(realAllocationPercent * 100) > 10000 ||
    realAllocatedCents > totalCents;

  const budgetPreview = editingTotal ? calculateNewBudget() : null;

  function handleEditTotalBudget() {
    if (!budgetData || saving) return;

    setNewTotalBudget(budgetData.totalBudget);
    setRecalculationMode("recalculate");
    setEditingTotal(true);
    setSaveMessage(null);
  }

  function calculateNewBudget() {
    if (!budgetData) return null;

    const value = newTotalBudget.trim();

    // MySQL supports a maximum of two decimal places.
    if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) {
      return null;
    }

    const newTotalCents = Math.round(Number(value) * 100);

    const updatedCategories = draftCategories.map((category) => {
      const oldPlannedCents = Math.round(
        Number(category.plannedAmount) * 100
      );

      if (recalculationMode === "recalculate") {
        // Keep percentages; calculate amounts from the new total.
        const plannedCents = calculatePlannedCents(
          newTotalCents,
          category.allocationPercentage
        );

        return {
          ...category,
          newPercentage: Number(category.allocationPercentage ?? 0),
          newAmount: plannedCents / 100,
        };
      }

      // Keep existing planned amounts; calculate new percentages.
      const newPercentage =
        newTotalCents > 0
          ? (oldPlannedCents / newTotalCents) * 100
          : oldPlannedCents === 0
            ? 0
            : NaN;

      return {
        ...category,
        newPercentage,
        newAmount: oldPlannedCents / 100,
      };
    });

    const totalAllocated = updatedCategories.reduce(
      (sum, category) =>
        sum + Math.round(category.newAmount * 100),
      0
    );

    return {
      newTotal: newTotalCents / 100,
      categories: updatedCategories,
      allocated: totalAllocated / 100,
      unallocated: (newTotalCents - totalAllocated) / 100,
    };
  }

  function validateBudgetPreview(): string | null {
    if (!budgetData || !eventId) {
      return "Please select an event first.";
    }

    if (!canEditTotalBudget) {
      return "Only the event owner can change the total budget.";
    }

    const preview = calculateNewBudget();

    if (!preview) {
      return "Please enter a valid total budget.";
    }

    if (preview.unallocated < 0) {
      return "Category amounts cannot exceed the total budget.";
    }

    if (
      draftCategories.some(
        (category) =>
          category.allocationPercentage === null ||
          category.allocationPercentage === ""
      )
    ) {
      return "Please complete all category percentages first.";
    }

    // Percentages are stored with a maximum of 2 decimal places.
    const newTotalCents = Math.round(preview.newTotal * 100);

    for (const category of preview.categories) {
      if (
        !Number.isFinite(category.newPercentage) ||
        category.newPercentage < 0 ||
        category.newPercentage > 100
      ) {
        return `Invalid allocation for "${category.name}".`;
      }

      const roundedPercentage =
        Math.round(category.newPercentage * 100) / 100;

      const calculatedCents = calculatePlannedCents(
        newTotalCents,
        roundedPercentage.toFixed(2)
      );

      const expectedCents = Math.round(
        category.newAmount * 100
      );

      if (Math.abs(calculatedCents - expectedCents) > 1) {
        return (
          `The amount for "${category.name}" cannot be preserved ` +
          "accurately using two-decimal percentages. " +
          "Choose Recalculate planned amounts or adjust the total."
        );
      }
    }

    return null;
  }

  async function handleSaveTotalBudget() {
    if (!eventId || !budgetData || saving || savingTotal) {
      return;
    }

    // The event owner is the only user allowed to change the total.
    if (!canEditTotalBudget) {
      setSaveMessage(
        "Only the event owner can change the total budget."
      );
      return;
    }

    // Do not overwrite unsaved category edits.
    const hasUnsavedChanges =
      draftCategories.length !== budgetData.categories.length ||
      draftCategories.some((category, index) => {
        const original = budgetData.categories[index];

        return (
          !original ||
          category.categoryId !== original.categoryId ||
          category.name !== original.name ||
          category.sortOrder !== original.sortOrder ||
          category.allocationPercentage !==
          original.allocationPercentage
        );
      });

    if (hasUnsavedChanges) {
      setSaveMessage(
        "Please save your category changes before updating the total budget."
      );
      return;
    }

    const validationError = validateBudgetPreview();

    if (validationError) {
      setSaveMessage(validationError);
      return;
    }

    const preview = calculateNewBudget();

    if (!preview) {
      setSaveMessage("Invalid budget preview.");
      return;
    }

    const confirmed = window.confirm(
      `Change the total budget to $${formatMoney(preview.newTotal)}?`
    );

    if (!confirmed) return;

    setSavingTotal(true);
    setSaveMessage(null);

    try {
      const requestEventId = eventId;

      // Build the complete list of existing category allocations.
      const categoriesToSave = preview.categories.map((category) => ({
        categoryId: category.categoryId,
        allocationPercentage: category.newPercentage.toFixed(2),
        plannedAmount: category.newAmount.toFixed(2),
      }));

      // Update the total and its categories in one MySQL transaction.
      await saveTotalBudget(requestEventId, {
        totalBudget: preview.newTotal.toFixed(2),
        categories: categoriesToSave,
      });

      // The save may finish after the user has selected another event.
      if (!isActiveEvent(requestEventId)) {
        return;
      }

      // Retrieve the updated values from MySQL.
      const updatedBudget = await fetchBudgetCategories(requestEventId);

      // Do not display Event A's data if the user switched to Event B.
      if (!isActiveEvent(requestEventId)) {
        return;
      }

      setBudgetData(updatedBudget);

      setDraftCategories(
        updatedBudget.categories.map((category) => ({
          ...category,
        }))
      );
      
      // Refresh shared event details so Dashboard shows the updated total.
      reloadDetails();

      setEditingTotal(false);
      setSaveMessage(
        "Total budget and category allocations updated successfully."
      );
    } catch (err: unknown) {
      if (isActiveEvent(eventId)) {
        setSaveMessage(
          err instanceof Error
            ? `Failed to update total budget: ${err.message}`
            : "Failed to update total budget."
        );
      }
    } finally {
      setSavingTotal(false);
    }
  }

  // Save new and edited categories through the backend API.
  async function handleSaveChanges() {
    if (!eventId || !budgetData || saving) {
      return;
    }

    if (isOverAllocated) {
      setSaveMessage("Total allocation cannot exceed 100%.");
      return;
    }

    if (draftCategories.some((category) =>
      category.allocationPercentage === null ||
      category.allocationPercentage === "" ||
      !Number.isFinite(Number(category.allocationPercentage)) ||
      Number(category.allocationPercentage) < 0
    )
    ) {
      setSaveMessage("Please enter a valid percentage for every category.");
      return;
    }

    const categoryNames = draftCategories.map(
      (category) => category.name.trim()
    );

    if (categoryNames.some((name) => name.length === 0 || name.length > 100)) {
      setSaveMessage(
        "Category names must contain between 1 and 100 characters."
      );
      return;
    }

    if (new Set(categoryNames.map((name) => name.toLowerCase())).size !== categoryNames.length) {
      setSaveMessage("Category names must be unique.");
      return;
    }

    const requestEventId = eventId;

    setSaving(true);
    setSaveMessage(null);

    try {
      for (const category of draftCategories) {
        const percentage = category.allocationPercentage!;

        const plannedCents = calculatePlannedCents(
          totalCents,
          percentage
        );

        const input = {
          name: category.name.trim(),
          allocationPercentage: Number(percentage).toFixed(2),
          plannedAmount: (plannedCents / 100).toFixed(2),
          sortOrder: category.sortOrder,
        };

        if (category.categoryId.startsWith("new-")) {
          // New category: INSERT using POST.
          await addBudgetCategory(
            requestEventId,
            input
          );
        } else {
          // Existing category: UPDATE using PATCH.
          await editBudgetCategory(
            requestEventId,
            category.categoryId,
            input
          );
        }
      }

      // Reload the budget from MySQL after saving.
      // Do not reload if the user switched to another event.
      if (!isActiveEvent(requestEventId)) {
        return;
      }

      const updatedBudget = await fetchBudgetCategories(
        requestEventId
      );

      // Make sure the user is still viewing the same event.
      if (!isActiveEvent(requestEventId)) {
        return;
      }

      setBudgetData(updatedBudget);
      setDraftCategories(
        updatedBudget.categories.map((category) => ({
          ...category,
        }))
      );

      setSaveMessage("Budget changes saved successfully.");
    } catch (err: unknown) {
      if (isActiveEvent(requestEventId)) {
        setSaveMessage(
          err instanceof Error
            ? `Save failed: ${err.message}. Some changes may already have been saved.`
            : "Failed to save budget categories."
        );
      }
    } finally {
      setSaving(false);
    }
  }

  // Real event budget page.
  if (eventId) {
    return (
      <>
        <PageHeader page="budget" />

        {loading ? (
          <Card>
            <p>Loading budget categories...</p>
          </Card>
        ) : error ? (
          <Card>
            <p role="alert">Error: {error}</p>
          </Card>
        ) : budgetData ? (
          <>
            <div
              className={`budget-overview ${editingTotal ? "budget-overview--editing" : ""}`}
            >

              <Card>
                <span>Total event budget</span>

                <strong>${formatMoney(realTotal)}</strong>

                {!editingTotal ? (
                  canEditTotalBudget ? (
                    <Button
                      variant="secondary"
                      onClick={handleEditTotalBudget}
                    >
                      Edit total budget
                    </Button>
                  ) : (
                    <small>
                      Only the event owner can edit the total budget.
                    </small>
                  )
                ) : (
                  <div className="budget-edit">
                    <label htmlFor="new-total-budget">
                      New total budget ($)
                    </label>

                    <input
                      id="new-total-budget"
                      type="number"
                      min="0"
                      max="9999999999.99"
                      step="0.01"
                      value={newTotalBudget}
                      onChange={(event) =>
                        setNewTotalBudget(event.target.value)
                      }
                    />

                    <p>How should category allocations change?</p>

                    <label>
                      <input
                        type="radio"
                        name="recalculation-mode"
                        checked={recalculationMode === "recalculate"}
                        onChange={() => setRecalculationMode("recalculate")}
                      />
                      Recalculate planned amounts (keep percentages)
                    </label>

                    <label>
                      <input
                        type="radio"
                        name="recalculation-mode"
                        checked={recalculationMode === "keep"}
                        onChange={() => setRecalculationMode("keep")}
                      />
                      Keep planned amounts (recalculate percentages)
                    </label>

                    {budgetPreview ? (
                      <div className="budget-preview">
                        <h4>Budget Preview</h4>

                        <p>
                          New total: ${formatMoney(budgetPreview.newTotal)}
                        </p>

                        <p>
                          Allocated: ${formatMoney(budgetPreview.allocated)}
                        </p>

                        <p>
                          Unallocated: ${formatMoney(budgetPreview.unallocated)}
                        </p>

                        <div className="budget-table table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Category</th>
                                <th>New %</th>
                                <th>New Amount</th>
                              </tr>
                            </thead>

                            <tbody>
                              {budgetPreview.categories.map((category) => (
                                <tr key={category.categoryId}>
                                  <td>{category.name}</td>
                                  <td>
                                    {Number.isFinite(category.newPercentage)
                                      ? `${category.newPercentage.toFixed(2)}%`
                                      : "N/A"}
                                  </td>
                                  <td>${formatMoney(category.newAmount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {budgetPreview.unallocated < 0 && (
                          <p role="alert" className="negative">
                            Categories exceed the new total budget.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p role="alert">
                        Enter a valid total budget between $0 and
                        $9,999,999,999.99.
                      </p>
                    )}

                    <Button
                      variant="primary"
                      onClick={() => {
                        void handleSaveTotalBudget();
                      }}
                    >
                      {savingTotal ? "Saving budget..." : "Save total budget"}
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditingTotal(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </Card>

              <Card>
                <span>Allocated</span>
                <strong>${formatMoney(realAllocated)}</strong>
                <small>{realAllocationPercent.toFixed(2)}% allocated</small>
              </Card>

              <Card className="remaining-card">
                <span>Unallocated</span>
                <strong>${formatMoney(realUnallocated)}</strong>
                <small>
                  {isOverAllocated
                    ? "Budget is over-allocated"
                    : "Available for allocation"}
                </small>
              </Card>
            </div>

            <Card>
              <div className="card-head">
                <div>
                  <h3>Category allocations</h3>
                  <p>
                    Edit percentages to customize your event budget.
                  </p>
                </div>

                <Badge tone={isOverAllocated ? "warning" : "success"}>
                  {isOverAllocated
                    ? "Over-allocated"
                    : "Within budget"}
                </Badge>
              </div>

              {/* Add Category button and form */}
              <Button
                variant="secondary"
                onClick={() => setShowAddCategory(!showAddCategory)}
              >
                {showAddCategory ? "Cancel" : "Add category"}
              </Button>

              {showAddCategory && (
                <div className="budget-add-category">
                  <input
                    type="text"
                    placeholder="Category name"
                    aria-label="New category name"
                    value={newCategoryName}
                    onChange={(event) =>
                      setNewCategoryName(event.target.value)
                    }
                  />

                  <Button onClick={handleAddCategory}>
                    Add
                  </Button>
                </div>
              )}

              {/* Budget category table */}
              <div className="budget-table table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Allocation %</th>
                      <th>Planned Amount</th>
                      <th>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {draftCategories.map((category) => {
                      const amountCents = calculatePlannedCents(
                        totalCents,
                        category.allocationPercentage
                      );

                      return (
                        <tr key={category.categoryId}>
                          <td>
                            <input
                              type="text"
                              maxLength={100}
                              aria-label={`Edit ${category.name} name`}
                              value={category.name}
                              onChange={(event) =>
                                updateCategoryName(
                                  category.categoryId,
                                  event.target.value
                                )
                              }
                            />
                          </td>

                          <td>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              aria-label={`${category.name} percentage`}
                              value={category.allocationPercentage ?? ""}
                              onChange={(event) =>
                                updateAllocation(
                                  category.categoryId,
                                  event.target.value
                                )
                              }
                            />
                            %
                          </td>
                          <td>
                            ${formatMoney(amountCents / 100)}
                          </td>

                          <td>
                            <Button
                              variant="danger"
                              onClick={() => {
                                void handleDeleteCategory(category.categoryId);
                              }}
                            >
                              Delete
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {isOverAllocated && (
                <p role="alert" className="negative">
                  Your category allocations exceed 100%.
                  Reduce them before saving.
                </p>
              )}

              <div className="table-footer">
                <span>
                  Edit category allocations, then click Save changes.
                </span>

                <Button
                  variant="secondary"
                  onClick={() => {
                    void handleSaveChanges();
                  }}
                >
                  {saving ? "Saving..." : "Save changes"}
                </Button>
              </div>

              {saveMessage && (
                <div
                  className="budget-notification"
                  role="status"
                >
                  <span className="budget-notification-icon">✓</span>
                  <span>{saveMessage}</span>
                </div>
              )}
            </Card>
          </>
        ) : (
          <Card>
            <p>No budget data available.</p>
          </Card>
        )}
      </>
    );
  }

  // Original mock Budget page, used until event selection is integrated.
  return (
    <>
      <PageHeader
        page="budget"
        action={
          <>
            <Button variant="secondary" onClick={openReset} icon="spark">
              Use template
            </Button>
            <Button icon="plus">Add category</Button>
          </>
        }
      />

      <div className="budget-overview">
        <Card>
          <span>Total event budget</span>
          <div className="budget-edit">
            <b>$</b>
            <input
              inputMode="numeric"
              aria-label="Total event budget"
              value={total}
              onChange={(e) =>
                setTotal(Number(e.target.value.replace(/\D/g, "")))
              }
            />
            <button aria-label="Edit total budget">
              <Icon name="edit" size={16} />
            </button>
          </div>
          <small>Demo budget</small>
        </Card>

        <Card>
          <span>Allocated</span>
          <strong>${allocated.toLocaleString()}</strong>
          <div className="progress">
            <i style={{ width: `${Math.min(100, total ? allocated / total * 100 : 0)}%` }} />
          </div>
          <small>Based on demo category allocations</small>
        </Card>

        <Card>
          <span>Spent so far</span>
          <strong>${SPENT_TOTAL.toLocaleString()}</strong>
          <div className="progress coral">
            <i style={{ width: `${Math.min(100, total ? SPENT_TOTAL / total * 100 : 0)}%` }} />
          </div>
          <small>Demo spending data</small>
        </Card>

        <Card className="remaining-card">
          <span>Remaining</span>
          <strong>${(total - SPENT_TOTAL).toLocaleString()}</strong>
          <small>Demo values only</small>
        </Card>
      </div>

      <Card>
        <div className="card-head">
          <div>
            <h3>Category allocations</h3>
            <p>
              Based on our Wedding Essentials template.
              Edit any amount to make it yours.
            </p>
          </div>
          <Badge tone="success">Demo</Badge>
        </div>

        <div className="budget-table table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Recommended</th>
                <th>Allocation</th>
                <th>Spent</th>
                <th>Remaining</th>
                <th></th>
              </tr>
            </thead>

            <tbody>
              {categories.map((c, i) => {
                const amount = Math.round((total * c.pct) / 100);
                const spent = spentByCategory[i] ?? 0;

                return (
                  <tr key={c.name}>
                    <td>
                      <span
                        className="category-dot"
                        style={{ background: c.color }}
                      />
                      {c.name}
                    </td>

                    <td>{budgetDefaults[i].pct}%</td>

                    <td>
                      <div className="table-money">
                        ${" "}
                        <input
                          inputMode="numeric"
                          aria-label={`${c.name} allocation`}
                          value={amount}
                          onChange={(e) => {
                            const value = Number(
                              e.target.value.replace(/\D/g, "")
                            );

                            const pct = total
                              ? Math.round((value / total) * 100)
                              : 0;

                            setCategories(
                              categories.map((x, n) =>
                                n === i ? { ...x, pct } : x
                              )
                            );
                          }}
                        />
                      </div>
                    </td>

                    <td>${spent.toLocaleString()}</td>

                    <td className={amount - spent < 0 ? "negative" : ""}>
                      ${(amount - spent).toLocaleString()}
                    </td>

                    <td>
                      <button
                        className="icon-btn"
                        aria-label="More options"
                      >
                        <Icon name="more" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="table-footer">
          <span>
            <Icon name="spark" size={15} /> Demo calculations only.
          </span>
          <Button variant="secondary">Save changes</Button>
        </div>
      </Card>
    </>
  );
}
