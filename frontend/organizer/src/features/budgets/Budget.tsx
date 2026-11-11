import { useEffect, useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";
import { budgetDefaults } from "../../data/mockData";
import {
  fetchBudgetCategories,
  editBudgetCategory,
  addBudgetCategory,
  removeBudgetCategory,
  type BudgetCategory,
  type EventBudgetResponse,
} from "./budgetApi";

const SPENT_TOTAL = 22440;
const spentByCategory = [12800, 4200, 1900, 2850, 690, 0, 0];

interface BudgetProps {
  openReset: () => void;
  eventId?: string;
  accessToken?: string;
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

export function Budget({
  openReset,
  eventId,
  accessToken,
}: BudgetProps) {
  // Original mock-data page.
  const [total, setTotal] = useState(35000);
  const [categories, setCategories] = useState(budgetDefaults);

  const allocated = categories.reduce(
    (sum, category) =>
      sum + Math.round((total * category.pct) / 100),
    0
  );

  // Real event budget state.
  const [budgetData, setBudgetData] =
    useState<EventBudgetResponse | null>(null);

  const [draftCategories, setDraftCategories] =
    useState<BudgetCategory[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Add Category form state.
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showAddCategory, setShowAddCategory] = useState(false);

  // Load actual budget data when an event is selected.
  useEffect(() => {
    if (!eventId || !accessToken) {
      setBudgetData(null);
      setDraftCategories([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadBudget() {
      setLoading(true);
      setError(null);
      setBudgetData(null);
      setDraftCategories([]);
      setSaveMessage(null);

      try {
        const data = await fetchBudgetCategories(
          eventId!,
          accessToken
        );

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
  }, [eventId, accessToken]);

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
    if (!eventId || !accessToken) {
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
      await removeBudgetCategory(
        eventId,
        categoryId,
        accessToken
      );

      // Reload categories from MySQL.
      const updatedBudget = await fetchBudgetCategories(
        eventId,
        accessToken
      );

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

  // Save new and edited categories through the backend API.
  async function handleSaveChanges() {
    if (!eventId || !accessToken || !budgetData || saving) {
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
            eventId,
            input,
            accessToken
          );
        } else {
          // Existing category: UPDATE using PATCH.
          await editBudgetCategory(
            eventId,
            category.categoryId,
            input,
            accessToken
          );
        }
      }

      // Reload the budget from MySQL after saving.
      const updatedBudget = await fetchBudgetCategories(
        eventId,
        accessToken
      );

      setBudgetData(updatedBudget);
      setDraftCategories(
        updatedBudget.categories.map((category) => ({
          ...category,
        }))
      );

      setSaveMessage("Budget changes saved successfully.");
    } catch (err: unknown) {
      setSaveMessage(
        err instanceof Error
          ? `Save failed: ${err.message}. Some changes may already have been saved.`
          : "Failed to save budget categories."
      );
    } finally {
      setSaving(false);
    }
  }

  // Real event budget page.
  if (eventId) {
    return (
      <>
        <PageHeader page="budget" />

        {!accessToken ? (
          <Card>
            <p>Authentication is required to load this event's budget.</p>
          </Card>
        ) : loading ? (
          <Card>
            <p>Loading budget categories...</p>
          </Card>
        ) : error ? (
          <Card>
            <p role="alert">Error: {error}</p>
          </Card>
        ) : budgetData ? (
          <>
            <div className="budget-overview">
              <Card>
                <span>Total event budget</span>
                <strong>${formatMoney(realTotal)}</strong>
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
                <p role="status">{saveMessage}</p>
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
