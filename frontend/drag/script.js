document.addEventListener('DOMContentLoaded', () => {
    const photoContainer = document.querySelector('.photo-container');
    let draggedItem = null;
    let placeholder = null;

    // Event listener for drag start
    photoContainer.addEventListener('dragstart', (event) => {
        draggedItem = event.target;
        draggedItem.classList.add('dragging');

        // Create a placeholder element
        placeholder = document.createElement('div');
        placeholder.classList.add('placeholder');

        setTimeout(() => {
            draggedItem.style.display = 'none'; // Hide the dragged item temporarily
        }, 0);
    });

    // Event listener for drag end
    photoContainer.addEventListener('dragend', (event) => {
        draggedItem.classList.remove('dragging');
        draggedItem.style.display = 'block'; // Show the dragged item again
        placeholder.remove();
        draggedItem = null;
    });

    // Event listener for drag over (allow dropping)
    photoContainer.addEventListener('dragover', (event) => {
        event.preventDefault();

        const afterElement = getDragAfterElement(photoContainer, event.clientY);
        if (afterElement == null) {
            photoContainer.appendChild(placeholder);
        } else {
            photoContainer.insertBefore(placeholder, afterElement);
        }
    });

    // Event listener for drop
    photoContainer.addEventListener('drop', (event) => {
        event.preventDefault();
        photoContainer.insertBefore(draggedItem, placeholder);
    });

    // Function to determine the element after which the dragged item should be placed
    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.photo:not(.dragging)')];

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
});
