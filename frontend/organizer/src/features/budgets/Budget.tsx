import { useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";
import { budgetDefaults } from "../../data/mockData";

const SPENT_TOTAL = 22440;
const spentByCategory = [12800, 4200, 1900, 2850, 690, 0, 0];

export function Budget({ openReset }: { openReset: () => void }) {
  const [total, setTotal] = useState(35000);
  const [categories, setCategories] = useState(budgetDefaults);
  const allocated = categories.reduce((sum, c) => sum + Math.round((total * c.pct) / 100), 0);

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
              onChange={(e) => setTotal(Number(e.target.value.replace(/\D/g, "")))}
            />
            <button aria-label="Edit total budget">
              <Icon name="edit" size={16} />
            </button>
          </div>
          <small>Last updated today</small>
        </Card>
        <Card>
          <span>Allocated</span>
          <strong>${allocated.toLocaleString()}</strong>
          <div className="progress">
            <i style={{ width: "100%" }} />
          </div>
          <small>100% of your total budget</small>
        </Card>
        <Card>
          <span>Spent so far</span>
          <strong>${SPENT_TOTAL.toLocaleString()}</strong>
          <div className="progress coral">
            <i style={{ width: "64%" }} />
          </div>
          <small>64% of your total budget</small>
        </Card>
        <Card className="remaining-card">
          <span>Remaining</span>
          <strong>${(total - SPENT_TOTAL).toLocaleString()}</strong>
          <small>You’re on track</small>
        </Card>
      </div>
      <Card>
        <div className="card-head">
          <div>
            <h3>Category allocations</h3>
            <p>Based on our Wedding Essentials template. Edit any amount to make it yours.</p>
          </div>
          <Badge tone="success">Balanced</Badge>
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
                const spent = spentByCategory[i];
                return (
                  <tr key={c.name}>
                    <td>
                      <span className="category-dot" style={{ background: c.color }} />
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
                            const value = Number(e.target.value.replace(/\D/g, ""));
                            const pct = total ? Math.round((value / total) * 100) : 0;
                            setCategories(categories.map((x, n) => (n === i ? { ...x, pct } : x)));
                          }}
                        />
                      </div>
                    </td>
                    <td>${spent.toLocaleString()}</td>
                    <td className={amount - spent < 0 ? "negative" : ""}>
                      ${(amount - spent).toLocaleString()}
                    </td>
                    <td>
                      <button className="icon-btn" aria-label="More options">
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
            <Icon name="spark" size={15} /> Amounts update automatically when your total budget
            changes.
          </span>
          <Button variant="secondary">Save changes</Button>
        </div>
      </Card>
    </>
  );
}
