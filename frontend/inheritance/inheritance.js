

const animal = {
    eats: true,
    walk() {
        console.log("animal walks")
    }
}

const dog = {
    bark() {
        console.log("dog barks")
    }
}


// dog.__proto__ = animal;

// Now `dog` can access properties from `animal`
console.log(dog.eats);  // true (inherited from `animal`)

dog.walk();             // Animal walks (inherited from `animal`)
dog.bark();             // Dog barks (own method)

// ES6
class Animal {
    constructor(name) {
        this.name = name;
    }

    walk() {
        console.log(`${this.name} is walking`);
    }
}

class Dog extends Animal {
    bark() {
        console.log(`${this.name} barks`);
    }
}

const myDog = new Dog("Rex");
myDog.walk();  // Rex is walking (inherited from `Animal`)
myDog.bark();  // Rex barks (Dog's own method)
